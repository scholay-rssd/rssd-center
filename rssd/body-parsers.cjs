'use strict';
const {json,raw}=require('express');

function registerBodyParsers(app) {
  const editorial=json({limit:'68mb'});
  // Nest detects a parser by its function name, without checking its route.
  // Wrap this scoped parser so other routes still receive Nest's default
  // JSON parser, rawBody capture and small request limit.
  app.use('/rssd/v1/editorial',(req,res,next)=>editorial(req,res,next));
  app.use(['/copilot/{*splat}','/posts','/rssd/v1/submissions','/rssd/v1/drafts','/rssd/v1/media'],(req,res,next)=>{
    json({limit:'50mb'})(req,res,next);
  });
  app.use('/rssd/public/v1/community/discourse',raw({type:'application/json',limit:'512kb'}));
}

module.exports={registerBodyParsers};
