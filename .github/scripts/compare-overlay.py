#!/usr/bin/env python3
"""Compare immutable, public image filesystems; create a verified overlay recipe."""
import hashlib,json,os,re,shlex,subprocess,sys,tarfile
from collections import Counter
OLD='ghcr.io/scholay-rssd/rssd-center@sha256:d550dd8e433c39a25da7d38b1097c75522f9f29e88fec478b7766c2a24da12a3'
NEW='ghcr.io/scholay-rssd/rssd-center@sha256:2c9b5124221c22ddad8e79afdc60c6fc053ba582ca99eacaa7ef8ba2e9be85e1'
CANDIDATE='rssd-center-overlay:ci'
# Docker injects these per-container runtime mounts; they are not image content.
SKIP={'.dockerenv','etc/hostname','etc/hosts','etc/resolv.conf'}
def command(*args):return subprocess.check_output(args,text=True)
def inspect(image):return json.loads(command('docker','image','inspect',image))[0]
def config(image):
 value=dict(inspect(image)['Config']);value.pop('Labels',None);return value
def inventory(image):
 container=command('docker','create',image).strip()
 try:
  process=subprocess.Popen(['docker','export',container],stdout=subprocess.PIPE)
  items={}
  with tarfile.open(fileobj=process.stdout,mode='r|*') as archive:
   for obj in archive:
    name=obj.name.removeprefix('./').rstrip('/')
    if not name or name in SKIP or name.split('/')[0] in {'proc','sys','dev'}:continue
    if name in items:raise ValueError('duplicate archive path: '+name)
    pax={k:v for k,v in obj.pax_headers.items() if not k.endswith('time')}
    row={'type':obj.type.decode('latin1'),'mode':obj.mode,'uid':obj.uid,'gid':obj.gid,'link':obj.linkname,'size':obj.size,'mtime':None if name in {'etc','etc/mtab'} else obj.mtime,'pax':pax}
    if obj.isfile():
     digest=hashlib.sha256();stream=archive.extractfile(obj)
     while chunk:=stream.read(1024*1024):digest.update(chunk)
     row['sha256']=digest.hexdigest()
    items[name]=row
  process.stdout.close()
  if process.wait()!=0:raise RuntimeError('docker export failed')
  return items
 finally:subprocess.run(['docker','rm','-v',container],stdout=subprocess.DEVNULL,check=False)
def diff(a,b):return sorted(k for k in a.keys()|b.keys() if a.get(k)!=b.get(k))
def unchanged_dependency_mtime(path, old, new):
 # Only byte/metadata-identical installed dependencies, never caches or Next.
 parts=path.split('/')
 if not path.startswith('app/node_modules/') or len(parts)<3:return False
 if parts[2] in {'next','@next','.cache','.pnpm'}:return False
 if any(p.lower() in {'cache','.cache','caches'} for p in parts):return False
 if old is None or new is None:return False
 if old['type'] not in ('0','\x00','5','2'):return False
 return {k:v for k,v in old.items() if k!='mtime'}=={k:v for k,v in new.items() if k!='mtime'}

def write(path,value):
 with open(path,'w') as out:json.dump(value,out,sort_keys=True,separators=(',',':'))
def main():
 os.makedirs('/tmp/center-overlay',exist_ok=True)
 if sys.argv[1]=='prepare':
  a,b=inventory(OLD),inventory(NEW)
  allowed={p for p in diff(a,b) if unchanged_dependency_mtime(p,a.get(p),b.get(p))}
  # Preserve a hardlink only together with its identical regular-file target;
  # inventory confirms both images have the same target and other metadata.
  for p in diff(a,b):
   old,new=a.get(p),b.get(p)
   if not old or not new or old['type']!='1' or new['type']!='1':continue
   target=new['link'].removeprefix('./')
   if target not in allowed or not p.startswith('app/node_modules/'):continue
   parts=p.split('/')
   if parts[2] in {'next','@next','.cache','.pnpm'} or any(v.lower() in {'cache','.cache','caches'} for v in parts):continue
   if {k:v for k,v in old.items() if k!='mtime'}!={k:v for k,v in new.items() if k!='mtime'}:continue
   if a[target]['type'] not in ('0','\x00') or b[target]['type'] not in ('0','\x00'):continue
   allowed.add(p)
  # A hardlink shares mtime with its target. Never retain only part of a
  # group: if one alias is out of scope, reproduce the whole group.
  blocked_targets=set()
  for p,new in b.items():
   if new['type']=='1':
    target=new['link'].removeprefix('./')
    if p not in allowed and target in allowed:blocked_targets.add(target)
  allowed.difference_update(blocked_targets)
  allowed={p for p in allowed if b[p]['type']!='1' or b[p]['link'].removeprefix('./') not in blocked_targets}
  allowed=sorted(allowed)
  for p in allowed:b[p]['mtime']=a[p]['mtime']
  changed=diff(a,b)
  write('/tmp/center-overlay/new.json',b)
  write('/tmp/center-overlay/allowed-mtime.json',allowed)
  print('ALLOWED_IDENTICAL_DEPENDENCY_MTIME_COUNT',len(allowed))
  oldconfig,newconfig=config(OLD),config(NEW)
  if oldconfig!=newconfig:
   print('CONFIG_CHANGED_KEYS',sorted(k for k in oldconfig.keys()|newconfig.keys() if oldconfig.get(k)!=newconfig.get(k)));raise RuntimeError('Image startup configuration differs')
  print('FULL_ROOT_COUNTS',len(a),len(b),'CHANGED_PATHS',len(changed));print('DIFF_GROUPS',dict(Counter(x.split('/')[0] for x in changed)))
  with open('/tmp/center-overlay/changed.json','w') as out:json.dump([{'path':p,'old':a.get(p),'new':b.get(p)} for p in changed],out,indent=2)
  if not changed or len(changed)>50000:raise RuntimeError('Unexpectedly large complete difference set')
  safe=re.compile(r'^[a-zA-Z0-9_./@+~,()\[\]-]+$')
  if any(not safe.fullmatch(p) or p.startswith('/') or '..' in p.split('/') for p in changed):raise RuntimeError('Unexpected path')
  removes=[p for p in changed if p not in b or p in a and p in b and a[p]['type']!=b[p]['type']]
  for p in removes:
   if a[p]['type']=='5' and any(q.startswith(p+'/') for q in b):raise RuntimeError('Removing a nonempty target directory')
  needed={p for p in changed if p in b}
  if any(b[p]['type'] not in ('0','\x00','5','2','1') for p in needed):raise RuntimeError('Delta has unsupported file types')
  for p in needed:
   if b[p]['type']=='1':
    target=b[p]['link'].removeprefix('./')
    if target not in needed or b.get(target,{}).get('type') not in ('0','\x00'):
     raise RuntimeError('Hardlink target is not safely included in patch')
  container=command('docker','create',NEW).strip()
  try:
   process=subprocess.Popen(['docker','export',container],stdout=subprocess.PIPE)
   found=set()
   with tarfile.open(fileobj=process.stdout,mode='r|*') as source,tarfile.open('/tmp/center-overlay/patch.tar','w',format=tarfile.PAX_FORMAT) as patch:
    for obj in source:
     name=obj.name.removeprefix('./').rstrip('/')
     if name not in needed:continue
     if name in found:raise RuntimeError('duplicate changed path')
     found.add(name);patch.addfile(obj,source.extractfile(obj) if obj.isfile() else None)
   process.stdout.close()
   if process.wait()!=0 or found!=needed:raise RuntimeError('Incomplete patch extraction')
  finally:subprocess.run(['docker','rm','-v',container],stdout=subprocess.DEVNULL,check=False)
  lines=['# Derived in isolated CI; immutable public source images.',f'FROM {OLD}']
  ordered=sorted(removes,key=lambda x:(-x.count('/'),x))
  for i in range(0,len(ordered),100):lines.append('RUN rm -rf -- '+' '.join(shlex.quote('/'+p) for p in ordered[i:i+100]))
  lines.append('ADD patch.tar /')
  lines.append('LABEL org.opencontainers.image.revision="e80818aa55a6caa1d777eed958cc9c0aee944368" io.rssd.image.kind="experimental-derived-overlay" io.rssd.image.base-digest="sha256:d550dd8e433c39a25da7d38b1097c75522f9f29e88fec478b7766c2a24da12a3" io.rssd.image.target-digest="sha256:2c9b5124221c22ddad8e79afdc60c6fc053ba582ca99eacaa7ef8ba2e9be85e1"')
  open('/tmp/center-overlay/Dockerfile','w').write('\n'.join(lines)+'\n')
  print('PATCH_ENTRIES',len(needed),'REMOVE_PATHS',len(removes),'PATCH_TAR_BYTES',os.path.getsize('/tmp/center-overlay/patch.tar'))
 elif sys.argv[1]=='verify':
  expected=json.load(open('/tmp/center-overlay/new.json'));actual=inventory(CANDIDATE);changed=diff(expected,actual)
  if changed:
   print('OVERLAY_DIFFERENCES',len(changed));print('\n'.join(changed[:100]));raise RuntimeError('Overlay differs from target')
  if config(CANDIDATE)!=config(NEW):raise RuntimeError('Overlay startup configuration differs')
  old,new,overlay=map(inspect,[OLD,NEW,CANDIDATE]);layers=old['RootFS']['Layers'];olayers=overlay['RootFS']['Layers']
  if olayers[:len(layers)]!=layers:raise RuntimeError('Overlay does not inherit exact old layers')
  print('OVERLAY_TREE_MATCHES_DECLARED_MTIME_POLICY',len(actual));print('OLD_IMAGE_BYTES',old['Size']);print('TARGET_IMAGE_BYTES',new['Size']);print('OVERLAY_IMAGE_BYTES',overlay['Size']);print('OVERLAY_NEW_LAYER_UNCOMPRESSED_BYTES',overlay['Size']-old['Size']);print('OVERLAY_ID',overlay['Id']);print('OLD_SHARED_LAYERS',len(layers),'OVERLAY_NEW_LAYERS',len(olayers)-len(layers))
 else:raise ValueError('unknown operation')
if __name__=='__main__':main()
