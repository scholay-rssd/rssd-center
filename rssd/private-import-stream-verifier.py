"""Trusted, in-memory verifier; reads source bytes only from the bound tarball."""
import hashlib,io,json,re,tarfile
from pathlib import PurePosixPath
class InvalidArchive(ValueError):pass
class LimitExceeded(InvalidArchive):
 def __init__(self,code):super().__init__(code);self.code=code
SHA=re.compile(r'[0-9a-f]{64}\Z')
def digest(b):return hashlib.sha256(b).hexdigest()
def unique_json(b):
 def pairs(items):
  d={}
  for k,v in items:
   if k in d:raise InvalidArchive('duplicate JSON key')
   d[k]=v
  return d
 try:return json.loads(b,object_pairs_hook=pairs)
 except (ValueError,UnicodeDecodeError) as e:raise InvalidArchive('invalid JSON') from e
def safe(path):
 return isinstance(path,str) and bool(path) and not path.startswith('/') and '\\' not in path and '\0' not in path and all(x not in ('','.','..') for x in path.split('/'))
def validate_profile(profile):
 if not isinstance(profile,dict) or set(profile)!={'version','inventoryPath','metadataExceptions','unlistedMetadata'} or type(profile['version']) is not int or profile['version']!=1:raise InvalidArchive('invalid source profile')
 inv=profile['inventoryPath']
 if not safe(inv) or len(inv)>255 or any(ord(c)<32 or ord(c)==127 for c in inv) or '/' in inv or inv=='MANIFEST.json':raise InvalidArchive('invalid inventory path')
 paths={inv,'MANIFEST.json'}
 for kind in ('metadataExceptions','unlistedMetadata'):
  entries=profile[kind]
  if not isinstance(entries,list) or len(entries)>16:raise InvalidArchive('invalid package metadata profile')
  for e in entries:
   fields={'path','expectedBytes','expectedSha256','actualBytes','actualSha256'} if kind=='metadataExceptions' else {'path','bytes','sha256'}
   if not isinstance(e,dict) or set(e)!=fields:raise InvalidArchive('invalid package metadata profile')
   path=e['path']
   if not safe(path) or len(path)>255 or any(ord(c)<32 or ord(c)==127 for c in path) or '/' in path or path in paths:raise InvalidArchive('invalid metadata path')
   paths.add(path)
   for k in ('expectedBytes','actualBytes') if kind=='metadataExceptions' else ('bytes',):
    if type(e[k]) is not int or e[k]<0 or e[k]>16*1024*1024:raise InvalidArchive('invalid metadata size')
   for k in ('expectedSha256','actualSha256') if kind=='metadataExceptions' else ('sha256',):
    if not isinstance(e[k],str) or not SHA.fullmatch(e[k]):raise InvalidArchive('invalid metadata digest')
 return profile

def verify(data,expected_digest,site,workspace,profile):
 profile=validate_profile(profile)
 if isinstance(data,bytes) and len(data)>32*1024*1024:raise LimitExceeded('archive_too_large')
 if not isinstance(data,bytes) or not isinstance(expected_digest,str) or not SHA.fullmatch(expected_digest) or digest(data)!=expected_digest:raise InvalidArchive('archive digest mismatch')
 files={};seen=set();root=None;total=0
 try:
  with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
   for count,m in enumerate(tar):
    path=m.name.rstrip('/')
    if count>=5000:raise LimitExceeded('archive_entries_exceeded')
    if not safe(path) or path in seen or not(m.isfile() or m.isdir()):raise InvalidArchive('unsafe archive member')
    seen.add(path);prefix=path.split('/')[0]
    if root is None:root=prefix
    if prefix!=root:raise InvalidArchive('multiple archive roots')
    total+=m.size
    if total>128*1024*1024:raise LimitExceeded('expanded_archive_too_large')
    if m.isfile():
     if '/' not in path:raise InvalidArchive('file outside archive root')
     value=tar.extractfile(m).read();
     if len(value)!=m.size:raise InvalidArchive('truncated archive member')
     files[path[len(root)+1:]]=value
 except (tarfile.TarError,EOFError,OSError) as e:raise InvalidArchive('invalid archive') from e
 inventory_path=profile['inventoryPath']
 for path in ('MANIFEST.json',inventory_path):
  if path not in files:raise InvalidArchive('metadata unavailable')
  if len(files[path])>16*1024*1024:raise LimitExceeded('metadata_too_large')
 manifest=unique_json(files['MANIFEST.json']);inventory=unique_json(files[inventory_path])
 if not isinstance(manifest,dict) or not isinstance(manifest.get('files'),list) or not isinstance(inventory,dict) or not isinstance(inventory.get('items'),list) or not 0<len(inventory['items'])<=1000:raise InvalidArchive('invalid inventory or manifest')
 records={}; package_metadata_mismatch=[];exceptions={e['path']:e for e in profile['metadataExceptions']};unlisted={e['path']:e for e in profile['unlistedMetadata']}
 for r in manifest['files']:
  path=r.get('path') if isinstance(r,dict) else None
  if not safe(path) or path in records or type(r.get('bytes')) is not int or r['bytes']<0 or not isinstance(r.get('sha256'),str) or not SHA.fullmatch(r['sha256']):raise InvalidArchive('invalid manifest entry')
  value=files.get(path)
  if value is None:raise InvalidArchive('manifest file missing from archive')
  if len(value)!=r['bytes'] or digest(value)!=r['sha256']:
   difference={'path':path,'expectedBytes':r['bytes'],'actualBytes':len(value),'expectedSha256':r['sha256'],'actualSha256':digest(value)}
   if '/' in path or exceptions.get(path)!=difference:raise InvalidArchive('archived file differs from manifest')
   package_metadata_mismatch.append(difference)
  records[path]=r
 if inventory_path not in records:raise InvalidArchive('inventory absent from manifest')
 if {x['path'] for x in package_metadata_mismatch}!=set(exceptions):raise InvalidArchive('declared metadata difference not found')
 remaining=set(files)-set(records)-{'MANIFEST.json'}
 if remaining!=set(unlisted):raise InvalidArchive('unlisted archived file')
 for path in remaining:
  if len(files[path])!=unlisted[path]['bytes'] or digest(files[path])!=unlisted[path]['sha256']:raise InvalidArchive('unlisted metadata differs')
 # An exception is package-only metadata, never an item reference. All paths
 # under files/ are unconditionally checked against the original manifest.
 def contains_reference(value,path):
  if isinstance(value,str):return value==path or value.endswith('/'+path)
  if isinstance(value,list):return any(contains_reference(x,path) for x in value)
  if isinstance(value,dict):return any(contains_reference(x,path) for x in value.values())
  return False
 if any(contains_reference(item,path) for path in list(exceptions)+list(unlisted) for item in inventory['items']):raise InvalidArchive('package metadata is used as business evidence')
 items=[];keys=set()
 for item in inventory['items']:
  if not isinstance(item,dict) or item.get('siteId')!=site or item.get('spaceId')!=workspace:raise InvalidArchive('workspace or site mismatch')
  key=item.get('requestKey');article=item.get('articleId')
  if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',key) or key in keys or not isinstance(article,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',article):raise InvalidArchive('invalid request identity')
  if len(json.dumps(item,ensure_ascii=False,separators=(',',':')).encode('utf-8'))>2000000:raise InvalidArchive('metadata too large')
  keys.add(key);paths=item.get('paths',{}).get('copied')
  if not isinstance(paths,list) or not all(safe(x) for x in paths) or len(set(paths))!=len(paths):raise InvalidArchive('invalid evidence paths')
  selected=set(paths)
  def include(value):
   if not isinstance(value,str) or not value or '\\' in value or '\0' in value or '..' in value.split('/'):raise InvalidArchive('invalid original reference')
   hits=[p[6:] for p in records if p.startswith('files/') and (value==p[6:] or value.endswith('/'+p[6:]))]
   if len(hits)!=1:raise InvalidArchive('ambiguous original reference')
   selected.add(hits[0])
  for group in ('annex','imageRights','editorialBackup'):
   for ref in item.get(group,{}).get('files',[]):include(ref)
  if item.get('manuscript',{}).get('preparedPath'):include(item['manuscript']['preparedPath'])
  if item.get('notes',{}).get('present'):include(item['notes']['internalNotesPath'])
  if item.get('bilingual',{}).get('enVariantHits') or item.get('bilingual',{}).get('publishingFlowJobs') or item.get('cloudSync',{}).get('found'):raise InvalidArchive('related data requires review')
  if len(selected)>500:raise LimitExceeded('evidence_too_large')
  chosen=[]; identities={}; selected_bytes=0
  for path in sorted(selected):
   if 'files/'+path not in records:raise InvalidArchive('missing manifest file')
   b=files['files/'+path];r=records['files/'+path];selected_bytes+=len(b)
   if len(path)>2000:raise InvalidArchive('invalid evidence path')
   if len(b)>20*1024*1024 or selected_bytes>200*1024*1024:raise LimitExceeded('evidence_too_large')
   chosen.append({'path':path,'sha256':r['sha256'],'bytes':r['bytes'],'data':b})
   name=PurePosixPath(path).name
   if name in ('prepared.json','receipt.json'):
    if name in identities:raise InvalidArchive('ambiguous identity file')
    identities[name]=unique_json(b)
  prepared=identities.get('prepared.json',{});receipt=identities.get('receipt.json',{})
  source=prepared.get('sourceSha256')
  if prepared.get('requestKey')!=key or receipt.get('requestKey')!=key or prepared.get('data',{}).get('id')!=article or not isinstance(source,str) or not SHA.fullmatch(source) or source!=receipt.get('sourceSha256'):raise InvalidArchive('original request identity mismatch')
  items.append({'legacyKey':key,'articleId':article,'metadata':item,'files':chosen})
 return {'archive':data,'digest':expected_digest,'manifest':files['MANIFEST.json'],'inventory':files[inventory_path],'package_metadata_mismatch':package_metadata_mismatch,'items':items}
if __name__=='__main__':
 import base64,sys,os,threading,time
 try:
  parent=int(os.environ['RSSD_PRIVATE_IMPORT_PARENT_PID'])
  if parent<2:raise ValueError('invalid parent')
 except Exception:sys.exit(1)
 def watch_parent():
  while True:
   if os.getppid()!=parent:os._exit(1)
   time.sleep(.25)
 threading.Thread(target=watch_parent,daemon=True).start()
 if len(sys.argv)!=4:raise SystemExit('expected digest, site and workspace')
 try:
  with os.fdopen(3,'r') as profile_input:raw_profile=profile_input.read(16385)
  if len(raw_profile)>16384:raise InvalidArchive('source profile too large')
  profile=unique_json(raw_profile)
  data=sys.stdin.buffer.read(32*1024*1024+1);result=verify(data,*sys.argv[1:],profile)
  # No frame is emitted until complete archive, manifest, identity and scope
  # validation has succeeded. Large evidence bytes are encoded one at a time.
  def emit(value):
   encoded=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf8')
   if len(encoded)>32*1024*1024:raise LimitExceeded('frame_too_large')
   sys.stdout.buffer.write(encoded+b'\n')
  def text(b):return base64.b64encode(b).decode('ascii')
  emit({'type':'header','version':1,'digest':result['digest'],'itemCount':len(result['items']),'package_metadata_mismatch':result['package_metadata_mismatch']})
  emit({'type':'manifest','data':text(result['manifest'])})
  emit({'type':'inventory','data':text(result['inventory'])})
  count=0
  for ordinal,item in enumerate(result['items']):
   emit({'type':'item','ordinal':ordinal,'legacyKey':item['legacyKey'],'articleId':item['articleId'],'metadata':item['metadata'],'fileCount':len(item['files']),'files':[{'path':f['path'],'sha256':f['sha256'],'bytes':f['bytes']} for f in item['files']]})
   for index,f in enumerate(item['files']):
    emit({'type':'file','ordinal':ordinal,'index':index,'path':f['path'],'sha256':f['sha256'],'bytes':f['bytes'],'data':text(f['data'])});count+=1
  emit({'type':'end','items':len(result['items']),'files':count})
 except LimitExceeded as e:
  print('PRIVATE_IMPORT_LIMIT:'+e.code,file=sys.stderr);sys.exit(1)
 except Exception:
  print('archive validation failed',file=sys.stderr);sys.exit(1)
