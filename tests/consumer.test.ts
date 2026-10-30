import {test,expect} from "bun:test";
import {loadDeployment} from "region-intel/deployment";
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("installed shared package admits regional identity and rejects crossed policy",()=>{
 const d=loadDeployment(process.cwd()); expect(d.profile.id).toBe("crescent-city");
 const root=mkdtempSync(join(tmpdir(),"region-consumer-"));
 try { cpSync("configs",join(root,"configs"),{recursive:true});cpSync("region.json",join(root,"region.json"));
 const path=join(root,d.config.regionConfig);const policy=JSON.parse(readFileSync(path,"utf8"));policy.profileId="foreign-region";writeFileSync(path,JSON.stringify(policy));
 expect(()=>loadDeployment(root)).toThrow();
 }finally{rmSync(root,{recursive:true});}
});
