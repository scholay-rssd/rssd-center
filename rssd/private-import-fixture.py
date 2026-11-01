import hashlib,json,tarfile
from pathlib import Path

def fixture(root):
    extracted=Path(root)/'extracted';extracted.mkdir();items=[];files=[]
    for n in (1,2):
        item={'requestKey':f'request-{n}','articleId':f'article-{n}','siteId':'site','spaceId':'space','title':'SYNTHETIC PRIVATE TITLE','paths':{'copied':[],'missing':[]}}
        values={'prepared.json':{'requestKey':item['requestKey'],'sourceSha256':'a'*64,'expectedVersion':n,'data':{'id':item['articleId'],'markdown':'SYNTHETIC PRIVATE BODY'}},'receipt.json':{'requestKey':item['requestKey'],'sourceSha256':'a'*64,'status':'local_queued'},'notes.json':{'notes':'SYNTHETIC PRIVATE NOTES'}}
        for name,value in values.items():
            rel=f'today/{n}/{name}';path=extracted/'files'/rel;path.parent.mkdir(parents=True,exist_ok=True);data=json.dumps(value).encode();path.write_bytes(data);item['paths']['copied'].append(rel);files.append({'path':'files/'+rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        items.append(item)
    inventory=json.dumps({'items':items}).encode();(extracted/'INVENTORY.json').write_bytes(inventory);files.append({'path':'INVENTORY.json','bytes':len(inventory),'sha256':hashlib.sha256(inventory).hexdigest()});(extracted/'MANIFEST.json').write_bytes(json.dumps({'files':files}).encode())
    archive=Path(root)/'handoff.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:tar.add(extracted,arcname='handover')
    return {'root':str(extracted),'archive':str(archive),'digest':hashlib.sha256(archive.read_bytes()).hexdigest()}
