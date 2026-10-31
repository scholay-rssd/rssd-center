'use strict';
const p=require('./protocol.cjs');
function ownerContext(user,organization){
 // Postiz AuthMiddleware obtains a live database membership filtered by the
 // verified user. Its normal projection deliberately contains no userId.
 const members=organization?.users,member=Array.isArray(members)&&members.length===1?members[0]:null;
 if(!user?.id||!organization?.id||!member||member.disabled!==false||
   (member.userId!==undefined&&member.userId!==user.id)||!['SUPERADMIN','ADMIN'].includes(member.role))p.fail('Owner access required',403);
 return {orgId:organization.id,userId:user.id,admin:true,workspaceIds:null};
}
module.exports={ownerContext};
