"""Read one local regular archive without following any symlink."""
import json,os,stat,sys
try:
 with os.fdopen(3,'r') as f:config=json.load(f)
 path=config['archive']
 if not isinstance(path,str) or not path.startswith('/') or '\0' in path or any(x in ('','.','..') for x in path.split('/')[1:]):raise ValueError('invalid path')
 parts=path.split('/')[1:];directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for name in parts[:-1]:
   fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=fd
  fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  with os.fdopen(fd,'rb') as archive:
   before=os.fstat(archive.fileno())
   if not stat.S_ISREG(before.st_mode):raise ValueError('invalid archive')
   if before.st_size>32*1024*1024:
    print('PRIVATE_IMPORT_LIMIT:archive_too_large',file=sys.stderr);sys.exit(2)
   while chunk:=archive.read(1024*1024):sys.stdout.buffer.write(chunk)
   after=os.fstat(archive.fileno())
   if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('archive changed')
 finally:os.close(directory)
except Exception:
 print('archive read failed',file=sys.stderr);sys.exit(1)
