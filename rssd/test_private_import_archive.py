import hashlib,importlib.util,io,json,os,pathlib,signal,subprocess,tarfile,tempfile,time,unittest
here=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('verified_archive',here/'private-import-verified-archive.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
verify,InvalidArchive=mod.verify,mod.InvalidArchive
spec=importlib.util.spec_from_file_location('fixture',here/'private-import-fixture.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
def sha(b):return hashlib.sha256(b).hexdigest()
def members(data):
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:return [(m.name,t.extractfile(m).read()) for m in t if m.isfile()]
def pack(entries):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w:gz') as t:
  for name,data in entries:
   info=tarfile.TarInfo(name);info.size=len(data);t.addfile(info,io.BytesIO(data))
 return out.getvalue()
def profile():return {'version':1,'inventoryPath':'INVENTORY.json','metadataExceptions':[],'unlistedMetadata':[]}
def metadata_case(data):
 out=[]
 for p,b in members(data):
  if p.endswith('/MANIFEST.json'):
   obj=json.loads(b);obj['files'].append({'path':'package-info.txt','bytes':3,'sha256':sha(b'old')});b=json.dumps(obj).encode()
  out.append((p,b))
 out.append(('handover/package-info.txt',b'new'));return pack(out)
class VerifiedArchive(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.info=fixture.fixture(self.temp.name);self.archive=pathlib.Path(self.info['archive']).read_bytes()
 def tearDown(self):self.temp.cleanup()
 def check(self,data,source=None):return verify(data,sha(data),'site','space',source or profile())
 def test_archive_members_and_original_identity(self):
  v=self.check(self.archive);self.assertEqual(len(v['items']),2);self.assertEqual(sum(len(x['files']) for x in v['items']),6);self.assertEqual(v['package_metadata_mismatch'],[])
 def test_modified_business_file_with_fresh_outer_digest_is_rejected(self):
  es=[(p,b+b'X' if p.endswith('/prepared.json') else b) for p,b in members(self.archive)]
  with self.assertRaisesRegex(InvalidArchive,'differs from manifest'):self.check(pack(es))
 def test_duplicate_tar_name_rejected(self):
  es=members(self.archive);es.append(es[0])
  with self.assertRaisesRegex(InvalidArchive,'unsafe'):self.check(pack(es))
 def test_bound_package_metadata_mismatch_is_explicitly_preserved(self):
  p=profile();p['metadataExceptions']=[{'path':'package-info.txt','expectedBytes':3,'expectedSha256':sha(b'old'),'actualBytes':3,'actualSha256':sha(b'new')}]
  result=self.check(metadata_case(self.archive),p);self.assertEqual(len(result['package_metadata_mismatch']),1);self.assertEqual(result['package_metadata_mismatch'][0]['path'],'package-info.txt')
 def test_undeclared_or_changed_metadata_mismatch_is_rejected(self):
  data=metadata_case(self.archive)
  with self.assertRaisesRegex(InvalidArchive,'differs from manifest'):self.check(data)
  p=profile();p['metadataExceptions']=[{'path':'package-info.txt','expectedBytes':3,'expectedSha256':sha(b'old'),'actualBytes':3,'actualSha256':sha(b'bad')}]
  with self.assertRaisesRegex(InvalidArchive,'differs from manifest'):self.check(data,p)
 def test_metadata_exception_referenced_by_business_item_is_rejected(self):
  entries=members(metadata_case(self.archive));rewritten=[];inventory=None
  for name,data in entries:
   if name.endswith('/INVENTORY.json'):
    obj=json.loads(data);obj['items'][0]['source']='package-info.txt';data=json.dumps(obj).encode();inventory=data
   rewritten.append((name,data))
  final=[]
  for name,data in rewritten:
   if name.endswith('/MANIFEST.json'):
    obj=json.loads(data)
    for row in obj['files']:
     if row['path']=='INVENTORY.json':row['bytes']=len(inventory);row['sha256']=sha(inventory)
    data=json.dumps(obj).encode()
   final.append((name,data))
  p=profile();p['metadataExceptions']=[{'path':'package-info.txt','expectedBytes':3,'expectedSha256':sha(b'old'),'actualBytes':3,'actualSha256':sha(b'new')}]
  with self.assertRaisesRegex(InvalidArchive,'business evidence'):self.check(pack(final),p)
 def test_business_file_exception_is_never_accepted(self):
  p=profile();p['metadataExceptions']=[{'path':'files/work/prepared.json','expectedBytes':1,'expectedSha256':sha(b'a'),'actualBytes':1,'actualSha256':sha(b'b')}]
  with self.assertRaisesRegex(InvalidArchive,'metadata path'):self.check(self.archive,p)
 def test_compressed_archive_limit_is_explicit(self):
  with self.assertRaises(InvalidArchive) as error:verify(b'x'*(32*1024*1024+1),'0'*64,'site','space',profile())
  self.assertEqual(getattr(error.exception,'code',None),'archive_too_large')
 def test_expanded_archive_limit_is_explicit(self):
  class ZeroReader:
   def read(self,n=-1):return b'\0'*max(0,min(n,65536))
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w:gz') as tar:
   info=tarfile.TarInfo('handover/large.bin');info.size=128*1024*1024+1;tar.addfile(info,ZeroReader())
  data=out.getvalue()
  with self.assertRaises(InvalidArchive) as error:verify(data,sha(data),'site','space',profile())
  self.assertEqual(getattr(error.exception,'code',None),'expanded_archive_too_large')
 def test_oversized_metadata_limit_is_explicit(self):
  data=pack([('handover/MANIFEST.json',b' '*(16*1024*1024+1)),('handover/INVENTORY.json',b'{}')])
  with self.assertRaises(InvalidArchive) as error:verify(data,sha(data),'site','space',profile())
  self.assertEqual(getattr(error.exception,'code',None),'metadata_too_large')
 def test_wrong_outer_digest_and_cross_scope_rejected(self):
  with self.assertRaisesRegex(InvalidArchive,'digest'):verify(self.archive,'0'*64,'site','space',profile())
  with self.assertRaisesRegex(InvalidArchive,'workspace or site'):verify(self.archive,sha(self.archive),'other','space',profile())
class ParentDeath(unittest.TestCase):
 def run_interruption(self,path,digest):
  script="""const {spawn}=require('child_process'),fs=require('fs');
const [script,path,digest]=process.argv.slice(1);
const c=spawn('python3',[script,digest,'site','space'],{stdio:['pipe','ignore','ignore','pipe']});
c.stdio[3].end(JSON.stringify({version:1,inventoryPath:'INVENTORY.json',metadataExceptions:[],unlistedMetadata:[]}));c.stdin.end(fs.readFileSync(path));
console.log(c.pid);setInterval(()=>{},1000);"""
  helper=here/'private-import-verified-archive.py'
  parent=subprocess.Popen(['node','-e',script,str(helper.resolve()),str(path),digest],stdout=subprocess.PIPE,text=True)
  pid=None
  try:
   pid=int(parent.stdout.readline())
   deadline=time.monotonic()+5;running=False
   while time.monotonic()<deadline:
    status=subprocess.run(['ps','-o','rss=','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.split()
    if not status or status[1].startswith('Z'):break
    if int(status[0])>=30000:running=True;break
    time.sleep(.005)
   self.assertTrue(running,'helper must be alive and processing the fixture before SIGKILL')
   parent.kill();parent.wait(timeout=5)
   deadline=time.monotonic()+5
   while time.monotonic()<deadline:
    status=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
    if not status or status.startswith('Z'):
     pid=None;break
    time.sleep(.05)
   else:self.fail('orphaned private helper did not exit')
  finally:
   if parent.poll() is None:parent.kill();parent.wait()
   if parent.stdout:parent.stdout.close()
   if pid:
    try:os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
 def test_fifo_reader_rejects_without_blocking(self):
  with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as directory:
   path=pathlib.Path(directory)/'fifo';os.mkfifo(path)
   script="""const {spawn}=require('child_process');const c=spawn('python3',[process.argv[1]],{stdio:['ignore','ignore','ignore','pipe']});c.stdio[3].end(JSON.stringify({archive:process.argv[2]}));c.on('exit',code=>process.exit(code===1?0:1));"""
   result=subprocess.run(['node','-e',script,str((here/'private-import-read-archive.py').resolve()),str(path)],timeout=5)
   self.assertEqual(result.returncode,0)
 def test_large_archive_verifier_exits_when_parent_is_killed(self):
  with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as directory:
   path=pathlib.Path(directory)/'large.tar.gz'
   class ZeroReader:
    def read(self,n=-1):return b'\0'*max(0,min(n,65536))
   with tarfile.open(path,'w:gz') as tar:
    info=tarfile.TarInfo('handover/files/large.bin');info.size=120*1024*1024;tar.addfile(info,ZeroReader())
   self.run_interruption(path,sha(path.read_bytes()))
if __name__=='__main__':unittest.main()
