#!/usr/bin/env python3
"""Compare immutable, public image filesystems; create a verified overlay recipe."""
import hashlib,json,os,re,subprocess,sys,tarfile
from collections import Counter
OLD='ghcr.io/scholay-rssd/rssd-center@sha256:d550dd8e433c39a25da7d38b1097c75522f9f29e88fec478b7766c2a24da12a3'
NEW='ghcr.io/scholay-rssd/rssd-center@sha256:2c9b5124221c22ddad8e79afdc60c6fc053ba582ca99eacaa7ef8ba2e9be85e1'
CANDIDATE='rssd-center-overlay:ci'
SKIP={'etc/hostname','etc/hosts','etc/resolv.conf'}
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
    row={'type':obj.type.decode('latin1'),'mode':obj.mode,'uid':obj.uid,'gid':obj.gid,'link':obj.linkname,'size':obj.size,'pax':pax}
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
def write(path,value):
 with open(path,'w') as out:json.dump(value,out,sort_keys=True,separators=(',',':'))
def main():
 os.makedirs('/tmp/center-overlay',exist_ok=True)
 if sys.argv[1]=='prepare':
  a,b=inventory(OLD),inventory(NEW);changed=diff(a,b);write('/tmp/center-overlay/new.json',b)
  oldconfig,newconfig=config(OLD),config(NEW)
  if oldconfig!=newconfig:
   print('CONFIG_CHANGED_KEYS',sorted(k for k in oldconfig.keys()|newconfig.keys() if oldconfig.get(k)!=newconfig.get(k)));raise RuntimeError('Image startup configuration differs')
  print('FULL_ROOT_COUNTS',len(a),len(b),'CHANGED_PATHS',len(changed));print('DIFF_GROUPS',dict(Counter(x.split('/')[0] for x in changed)))
  with open('/tmp/center-overlay/changed.json','w') as out:json.dump([{'path':p,'old':a.get(p),'new':b.get(p)} for p in changed],out,indent=2)
  if not changed or len(changed)>100:raise RuntimeError('Unexpected difference set')
  safe=re.compile(r'^[a-zA-Z0-9_./@+~,-]+$')
  if any(not safe.fullmatch(p) or p.startswith('/') or '..' in p.split('/') for p in changed):raise RuntimeError('Unexpected path')
  creates=[p for p in changed if p not in a and b[p]['type']=='5']
  removes=[p for p in changed if p not in b]
  for p in removes:
   if a[p]['type']=='5' and any(q.startswith(p+'/') for q in b):raise RuntimeError('Removing a nonempty target directory')
  copies=[]
  for p in changed:
   if p not in b or b[p]['type']=='5':continue
   if b[p]['type'] not in ('0','\\x00') or b[p]['pax']:raise RuntimeError('Nonregular or extended-attribute delta requires review: '+p)
   copies.append(p)
  for p in changed:
   if p in a and p in b and b[p]['type']=='5':raise RuntimeError('Changed existing directory requires review: '+p)
  lines=['# Derived in isolated CI; immutable public source images.',f'FROM {NEW} AS target',f'FROM {OLD}']
  for p in sorted(creates,key=lambda x:(x.count('/'),x)):
   v=b[p];lines.append('RUN install -d -m %04o -o %d -g %d -- %s'%(v['mode'],v['uid'],v['gid'],'/'+p))
  for p in copies:
   v=b[p];lines.append('COPY --from=target --chown=%d:%d --chmod=%04o %s'%(v['uid'],v['gid'],v['mode'],json.dumps(['/'+p,'/'+p])))
  for p in sorted(removes,key=lambda x:(-x.count('/'),x)):lines.append('RUN rm -rf -- /'+p)
  lines.append('LABEL org.opencontainers.image.revision="e80818aa55a6caa1d777eed958cc9c0aee944368" io.rssd.image.kind="verified-overlay" io.rssd.image.base-digest="sha256:d550dd8e433c39a25da7d38b1097c75522f9f29e88fec478b7766c2a24da12a3" io.rssd.image.target-digest="sha256:2c9b5124221c22ddad8e79afdc60c6fc053ba582ca99eacaa7ef8ba2e9be85e1"')
  open('/tmp/center-overlay/Dockerfile','w').write('\n'.join(lines)+'\n')
  print('COPY_FILES',len(copies),'ADD_DIRS',len(creates),'REMOVE_PATHS',len(removes))
 elif sys.argv[1]=='verify':
  expected=json.load(open('/tmp/center-overlay/new.json'));actual=inventory(CANDIDATE);changed=diff(expected,actual)
  if changed:
   print('OVERLAY_DIFFERENCES',len(changed));print('\n'.join(changed[:100]));raise RuntimeError('Overlay differs from target')
  if config(CANDIDATE)!=config(NEW):raise RuntimeError('Overlay startup configuration differs')
  old,new,overlay=map(inspect,[OLD,NEW,CANDIDATE]);layers=old['RootFS']['Layers'];olayers=overlay['RootFS']['Layers']
  if olayers[:len(layers)]!=layers:raise RuntimeError('Overlay does not inherit exact old layers')
  print('OVERLAY_FILES_EQUAL',len(actual));print('OLD_IMAGE_BYTES',old['Size']);print('TARGET_IMAGE_BYTES',new['Size']);print('OVERLAY_IMAGE_BYTES',overlay['Size']);print('OVERLAY_NEW_LAYER_UNCOMPRESSED_BYTES',overlay['Size']-old['Size']);print('OVERLAY_ID',overlay['Id']);print('OLD_SHARED_LAYERS',len(layers),'OVERLAY_NEW_LAYERS',len(olayers)-len(layers))
 else:raise ValueError('unknown operation')
if __name__=='__main__':main()
