import {Controller,Get,Post,Param,Req,Res,UseFilters,Catch,ExceptionFilter,ArgumentsHost} from '@nestjs/common';
import {RssdService} from './rssd.service';
const {ProtocolError}=require('../../../../rssd/protocol.cjs');
@Catch(ProtocolError)
class CommunityFilter implements ExceptionFilter {catch(error:any,host:ArgumentsHost){host.switchToHttp().getResponse().status(error.status).json({error:error.message,code:error.code});}}
@Controller('/rssd/public/v1/community')
@UseFilters(CommunityFilter)
export class RssdCommunityController{
 constructor(private rssd:RssdService){}
 @Post('/discourse') async webhook(@Req() req:any,@Res() res:any){
  const result=await this.rssd.community.accept(Buffer.isBuffer(req.body)?req.body:req.rawBody,req.headers);res.status(result.statusCode).json(result.body);
 }
 @Get('/sites/:siteId') async links(@Param('siteId') siteId:string,@Res() res:any){res.set('Cache-Control','public, max-age=60').json(await this.rssd.community.publicLinks(siteId));}
}
