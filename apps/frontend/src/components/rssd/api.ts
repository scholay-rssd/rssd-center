'use client';
import { useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export class ApiError extends Error { constructor(message:string,public status:number,public code?:string){super(message);} }
export type RssdApi = (path:string,method?:string,data?:unknown)=>Promise<any>;
/** The signed-in owner's calls to /rssd/v1; a refused call throws the Center's own message. */
export function useRssdApi(): RssdApi {
  const fetch = useFetch();
  return useCallback(async(path:string,method='GET',data?:unknown)=>{
    const response=await fetch('/rssd/v1'+path,{method,...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json().catch(()=>({message:'中心返回了无法读取的响应'}));
    if(!response.ok)throw new ApiError(result.message || '操作失败',response.status,result.code);
    return result;
  },[fetch]);
}
