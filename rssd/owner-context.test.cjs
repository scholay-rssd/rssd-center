'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ownerContext}=require('./owner-context.cjs');
test('Postiz live membership projections authorize only enabled owners of the selected organization',()=>{
 const user={id:'owner'},member={role:'SUPERADMIN',disabled:false},org={id:'organization',users:[member]};
 assert.equal(ownerContext(user,org).admin,true);
 assert.equal(ownerContext(user,{...org,users:[{...member,userId:'owner',role:'ADMIN'}]}).orgId,'organization');
 for(const users of [[],[member,member],[{...member,role:'USER'}],[{...member,disabled:true}],[{...member,userId:'foreign'}]])assert.throws(()=>ownerContext(user,{...org,users}),{status:403});
 assert.throws(()=>ownerContext(null,org),{status:403});
});
