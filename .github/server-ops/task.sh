#!/bin/bash
# Задача 7 (только чтение): состояние автообновления приложений.
# Ключ читается из файла внутри node и никуда не печатается.
cd /opt/saas-gateway && node -e '
const fs=require("fs");const admin=require("firebase-admin");
const line=fs.readFileSync("/etc/saas-gateway.env","utf8").split("\n").find(l=>l.startsWith("FIREBASE_SERVICE_ACCOUNT_B64="));
const sa=JSON.parse(Buffer.from(line.split("=").slice(1).join("=").trim().replace(/^["\x27]|["\x27]$/g,""),"base64").toString());
admin.initializeApp({credential:admin.credential.cert(sa)});
const db=admin.firestore();
const ts=v=>v&&v.toDate?v.toDate().toISOString():v;
(async()=>{
 const r=(await db.doc("platformStatus/appRollout").get()).data()||{};
 console.log("appRollout:",JSON.stringify({...r,requestedAt:ts(r.requestedAt),startAfter:ts(r.startAfter),finishedAt:ts(r.finishedAt)}));
 const jobs=await db.collection("buildJobs").orderBy("createdAt","desc").limit(8).get();
 jobs.forEach(d=>{const j=d.data();console.log("job",ts(j.createdAt),j.tenantId,j.app||"",j.status,j.rolloutSha||"",String(j.errorMessage||"").slice(0,150));});
 const t=await db.collection("tenants").get();
 t.forEach(d=>{const x=d.data();if(x.appBuild)console.log("tenant",d.id,x.name||"",x.status||"",x.demo?"demo":"",JSON.stringify(x.appBuild));});
 process.exit(0);
})().catch(e=>{console.log("ошибка",e.message);process.exit(0)});'
journalctl -u saas-gateway --since "-6h" --no-pager | grep -iE "rollout|build|error" | tail -20
