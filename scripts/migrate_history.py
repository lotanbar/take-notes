"""One-time, verified migration from full-vault Git snapshots to object-reusing history."""
from __future__ import annotations
import argparse, base64, hashlib, json, os, shutil, stat, struct, subprocess, tempfile
from pathlib import Path

MAGIC=b"VNVLTV02"; TRAILER=b"VNTRLR02"
def run(args, cwd=None, data=None, env=None):
    return subprocess.run(args, cwd=cwd, input=data, check=True, stdout=subprocess.PIPE, env=env).stdout
def record(repo, commit): return run(["git","show",f"{commit}:vault.vlt"], repo)
def commits(repo): return run(["git","rev-list","--reverse","HEAD"], repo).decode().split()
def meta(repo, commit):
    timestamp=int(run(["git","show","-s","--format=%ct",commit],repo).decode().strip())
    message=run(["git","show","-s","--format=%B",commit],repo).decode(errors="replace").strip()
    return timestamp,message
def sha(data): return hashlib.sha256(data).hexdigest()

def parse(data):
    if len(data)<32 or data[:8]!=MAGIC or data[-8:]!=TRAILER: raise ValueError("invalid vault container")
    end=len(data)-24; version=struct.unpack("<Q",data[end+8:end+16])[0]; offset=8; records=[]
    while offset<end:
        tag=data[offset]; length=struct.unpack("<Q",data[offset+1:offset+9])[0]; payload=data[offset+9:offset+9+length]
        if tag not in (66,72) or len(payload)!=length: raise ValueError("invalid vault record")
        records.append((tag,offset+9,payload)); offset+=9+length
    if offset!=end or not records or records[-1][0]!=72: raise ValueError("missing manifest")
    return version,records

def compact(data):
    if data[:8] == MAGIC and data[-8:] != TRAILER:
        last=data.rfind(TRAILER)
        if last >= 24:
            data=data[:last+len(TRAILER)]
        else:
            offset=8; header_offset=None; header_end=None
            while offset+9 <= len(data):
                tag=data[offset]; length=struct.unpack("<Q",data[offset+1:offset+9])[0]; end=offset+9+length
                if tag not in (66,72) or end>len(data): break
                if tag==72: header_offset=offset; header_end=end
                offset=end
            if header_offset is None: raise ValueError("container has no recoverable manifest")
            data=data[:header_end]+struct.pack("<QQ",header_offset,2)+TRAILER
    if data[:8] != MAGIC:
        legacy=json.loads(data.decode("utf-8-sig")); out=bytearray(MAGIC)
        def migrate(node):
            content=node.pop("content",None)
            if content:
                payload=base64.b64decode(content); node["contentRef"]={"payloadOffset":len(out)+9,"length":len(payload),"checksum":sha(payload)}; out.extend(b"B"+struct.pack("<Q",len(payload))+payload)
            for child in node.get("children",[]): migrate(child)
        migrate(legacy["tree"]); legacy["version"]=2; legacy.setdefault("generation",0); legacy.setdefault("deviceId","history-migration")
        header=json.dumps(legacy,separators=(",",":"),ensure_ascii=False).encode(); header_offset=len(out); out.extend(b"H"+struct.pack("<Q",len(header))+header); out.extend(struct.pack("<QQ",header_offset,2)+TRAILER); parse(out); return bytes(out)
    version,records=parse(data); header=json.loads(records[-1][2]); by_offset={offset:payload for tag,offset,payload in records if tag==66}
    live=[]
    def rewrite_ref(ref):
        payload=by_offset.get(ref["payloadOffset"])
        if payload is None or len(payload)!=ref["length"] or (ref.get("checksum") and sha(payload)!=ref["checksum"].lower()): raise ValueError("broken live reference")
        live.append(payload); return {**ref,"payloadOffset":0,"length":len(payload),"checksum":sha(payload)}
    def node(value):
        if value.get("contentRef"): value["contentRef"]=rewrite_ref(value["contentRef"])
        if value.get("blobRefs"): value["blobRefs"]=[rewrite_ref(item) for item in value["blobRefs"]]
        for child in value.get("children",[]): node(child)
    node(header["tree"])
    out=bytearray(MAGIC); index=0
    def assign(value):
        nonlocal index
        if value.get("contentRef"):
            value["contentRef"]["payloadOffset"]=len(out)+9; payload=live[index]; index+=1; out.extend(b"B"+struct.pack("<Q",len(payload))+payload)
        refs=[]
        for ref in value.get("blobRefs",[]): ref["payloadOffset"]=len(out)+9; payload=live[index]; index+=1; out.extend(b"B"+struct.pack("<Q",len(payload))+payload); refs.append(ref)
        if refs: value["blobRefs"]=refs
        for child in value.get("children",[]): assign(child)
    assign(header["tree"])
    header_bytes=json.dumps(header,separators=(",",":"),ensure_ascii=False).encode(); header_offset=len(out); out.extend(b"H"+struct.pack("<Q",len(header_bytes))+header_bytes); out.extend(struct.pack("<QQ",header_offset,version)+TRAILER)
    parse(out); return bytes(out)

def snapshot(work, vault, original):
    version,records=parse(vault); refs=[]; objects=work/"objects"; objects.mkdir(exist_ok=True)
    for tag,_,payload in records:
        digest=sha(payload); target=objects/digest
        if not target.exists(): target.write_bytes(payload)
        refs.append({"tag":tag,"hash":digest,"length":len(payload)})
    revision={"format_version":version,"records":refs,"source_vault_hash":sha(vault),"original_commit_id":original}
    (work/"revision.json").write_text(json.dumps(revision,indent=2),encoding="utf-8")

def reconstruct(repo, commit):
    rev=json.loads(run(["git","show",f"{commit}:revision.json"],repo)); out=bytearray(MAGIC); header=0
    for item in rev["records"]:
        object_path=Path(repo)/"objects"/item["hash"]
        payload=object_path.read_bytes() if object_path.exists() else run(["git","show",f"{commit}:objects/{item['hash']}"],repo)
        if len(payload)!=item["length"] or sha(payload)!=item["hash"]: raise ValueError("object mismatch")
        if item["tag"]==72: header=len(out)
        out.extend(bytes([item["tag"]])+struct.pack("<Q",len(payload))+payload)
    out.extend(struct.pack("<QQ",header,rev["format_version"])+TRAILER)
    if sha(out)!=rev["source_vault_hash"]: raise ValueError("reconstruction mismatch")
    parse(out); return bytes(out)

def size(path): return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
def remove_tree(path):
    def writable(function, target, _error): os.chmod(target, stat.S_IWRITE); function(target)
    shutil.rmtree(path,onexc=writable)
def main():
    p=argparse.ArgumentParser(); p.add_argument("--source",required=True); p.add_argument("--current",required=True); p.add_argument("--destination",required=True); p.add_argument("--repo",action="append",required=True); p.add_argument("--delete-old",action="store_true"); p.add_argument("--skip-fsck",action="store_true"); p.add_argument("--resume",action="store_true"); a=p.parse_args()
    sources=[Path(x).resolve() for x in a.repo]; destination=Path(a.destination).resolve(); temporary=destination.with_name(destination.name+".migrating")
    if not a.skip_fsck:
        for source in sources: run(["git","fsck","--full","--no-dangling"],source)
    entries=[]; seen_commits=set()
    for source in sources:
        for commit in commits(source):
            if commit in seen_commits: continue
            seen_commits.add(commit)
            timestamp,message=meta(source,commit); entries.append((timestamp,message,commit,source))
    entries.sort(key=lambda row:(row[0],row[2]))
    processed=set(); seen=set()
    if temporary.exists() and a.resume:
        for existing in commits(temporary):
            revision=json.loads(run(["git","show",f"{existing}:revision.json"],temporary)); seen.add(revision["source_vault_hash"])
            if revision.get("original_commit_id"): processed.add(revision["original_commit_id"])
    else:
        if temporary.exists(): remove_tree(temporary)
        temporary.mkdir(parents=True); run(["git","init"],temporary); run(["git","config","user.name","Vault Notes"],temporary); run(["git","config","user.email","local-history@vault-notes.invalid"],temporary)
        (temporary/"SOURCE_PATH.txt").write_text(str(Path(a.source).resolve()).lower()+"\n",encoding="utf-8")
        (temporary/"RECOVERY.md").write_text("# Vault recovery\n\nEach commit references a complete encrypted revision through content-addressed objects.\n",encoding="utf-8")
    for timestamp,message,original,source in entries:
        if original in processed: continue
        vault=compact(record(source,original)); digest=sha(vault)
        if digest in seen: continue
        seen.add(digest)
        snapshot(temporary,vault,original); run(["git","add","."],temporary)
        text=message+(f"\n\nOriginal-Commit-ID: {original}" if original else "")
        env={**os.environ,"GIT_AUTHOR_DATE":f"@{timestamp} +0000","GIT_COMMITTER_DATE":f"@{timestamp} +0000"}
        run(["git","commit","--quiet","-m",text],temporary,env=env)
    current=compact(Path(a.current).read_bytes()); digest=sha(current)
    if digest not in seen:
        timestamp=int(Path(a.current).stat().st_mtime); snapshot(temporary,current,None); run(["git","add","."],temporary)
        env={**os.environ,"GIT_AUTHOR_DATE":f"@{timestamp} +0000","GIT_COMMITTER_DATE":f"@{timestamp} +0000"}; run(["git","commit","--quiet","-m","Current vault at history migration"],temporary,env=env)
    ids=commits(temporary)
    for commit in ids: reconstruct(temporary,commit)
    for commit in [ids[0],ids[len(ids)//2],ids[-1]]: compact(reconstruct(temporary,commit))
    run(["git","fsck","--full","--no-dangling"],temporary)
    if destination.exists(): raise RuntimeError(f"destination already exists: {destination}")
    temporary.rename(destination)
    deleted=[]; reclaimed=0
    if a.delete_old:
        for source in sources: reclaimed+=size(source); remove_tree(source); deleted.append(str(source))
    report={"repository":str(destination),"sourceCommits":len(entries),"uniqueRevisions":len(ids),"deletedPaths":deleted,"reclaimedBytes":reclaimed}
    print(json.dumps(report,indent=2))
if __name__=="__main__": main()
