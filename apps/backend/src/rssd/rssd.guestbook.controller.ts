import {Controller,Get,Post,Param,Req,Res,Body,UseFilters,Catch,ExceptionFilter,ArgumentsHost} from '@nestjs/common';
import {RssdService} from './rssd.service';
const {ProtocolError}=require('../../../../rssd/protocol.cjs');
@Catch(ProtocolError)
class GuestbookFilter implements ExceptionFilter {
 catch(error:any,host:ArgumentsHost){host.switchToHttp().getResponse().status(error.status).json({error:error.message,code:error.code});}
}
// Only the site's trusted reverse proxy holds its scoped credential. Visitor
// cookies and origin validation retain the existing same-origin guestbook API.
@Controller('/rssd/public/v1/guestbooks/:siteId')
@UseFilters(GuestbookFilter)
export class RssdGuestbookController {
 constructor(private rssd:RssdService){}
 @Get('/session') async session(@Param('siteId') siteId:string,@Req() req:any,@Res() res:any){
  const {cookie,body}=await this.rssd.guestbook.session(siteId,req.headers,req.cookies);
  res.set('Cache-Control','no-store');
  if(cookie)res.cookie(cookie.name,cookie.value,{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:365*86400*1000});
  res.json(body);
 }
 @Get('/messages') async messages(@Param('siteId') siteId:string,@Req() req:any,@Res() res:any){
  res.set('Cache-Control','public, max-age=60');res.json(await this.rssd.guestbook.publicMessages(siteId,req.headers));
 }
 @Post('/messages') async submit(@Param('siteId') siteId:string,@Req() req:any,@Body() body:any,@Res() res:any){
  const result=await this.rssd.guestbook.submit(siteId,req.headers,req.cookies,body);res.set('Cache-Control','no-store').status(result.replayed?200:201).json(result);
 }
}
