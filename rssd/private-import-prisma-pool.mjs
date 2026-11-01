// Provides only the pg-shaped interface used by the streaming transaction.
// Prisma owns the physical transaction; callers cannot issue arbitrary BEGINs.
const failure=()=>Error('Private import transaction unavailable');
export function prismaPool(prisma,{transactionTimeoutMs=120000,statementTimeoutMs=10000}={}){
 return {
  async query(sql,args=[]){return prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);return {rows:await tx.$queryRawUnsafe(sql,...args)};},{timeout:transactionTimeoutMs,maxWait:2000});},
  async connect(){let finish,abort,tx,done,readyResolve,readyReject,ended=false,commitStarted=false;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
   function start(){let signaled=false;done=prisma.$transaction(async inner=>{tx=inner;signaled=true;readyResolve();await new Promise((resolve,reject)=>{finish=resolve;abort=reject;});},{timeout:transactionTimeoutMs,maxWait:2000});done.catch(error=>{if(!signaled)readyReject(error);});return ready;}
   return {get commitStarted(){return commitStarted;},async query(sql,args=[]){if(sql==='BEGIN'){await start();return {rows:[]};}if(sql==='COMMIT'){if(ended||!finish)throw failure();ended=true;commitStarted=true;finish();await done;return {rows:[]};}if(sql==='ROLLBACK'){if(!ended&&abort){ended=true;abort(failure());await done.catch(()=>{});}return {rows:[]};}if(!tx||ended)throw failure();const returns=/^\s*SELECT\b/i.test(sql)||/\bRETURNING\b/i.test(sql);if(returns){const rows=await tx.$queryRawUnsafe(sql,...args);return {rows,rowCount:rows.length};}return {rows:[],rowCount:await tx.$executeRawUnsafe(sql,...args)};},release(){if(!ended&&abort){ended=true;abort(failure());void done.catch(()=>{});}}};
  }
 };
}
