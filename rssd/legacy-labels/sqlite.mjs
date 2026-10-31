import {DatabaseSync,backup} from 'node:sqlite';

// SQLite is bundled with the pinned Node 24 runtime, avoiding host compiler and
// libc dependencies. Transactions stay synchronous; nested operations use savepoints.
// node:sqlite recompiles on every prepare(), so statements are cached by SQL text;
// callers only use synchronous get/all/run, which makes a shared statement safe.
export default class Database {
  constructor(path){this.handle=new DatabaseSync(path);this.depth=0;this.statements=new Map();}
  prepare(sql){
    let statement=this.statements.get(sql);
    if(!statement){
      statement=this.handle.prepare(sql);
      if(this.statements.size>=500)this.statements.delete(this.statements.keys().next().value);
      this.statements.set(sql,statement);
    }
    return statement;
  }
  exec(sql){return this.handle.exec(sql);}
  pragma(sql){return this.handle.exec('PRAGMA '+sql);}
  close(){this.statements.clear();this.handle.close();}
  backup(path){return backup(this.handle,path);}
  transaction(fn){return (...args)=>{
    const level=this.depth++,savepoint='nested_'+level;
    try {
      this.exec(level?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');
      try {const result=fn(...args);if(result?.then)throw new Error('Transactions must be synchronous');this.exec(level?'RELEASE '+savepoint:'COMMIT');return result;}
      catch(error){this.exec(level?'ROLLBACK TO '+savepoint:'ROLLBACK');if(level)this.exec('RELEASE '+savepoint);throw error;}
    }finally{this.depth--;}
  };}
}
