// Network policy for this dedicated read-only host, never the user's browser.
const staticHosts=['douyin.com','douyincdn.com','douyinpic.com','douyinstatic.com','byteimg.com','bytedance.com','bytedance.net','ibytedtos.com','pstatp.com','ttwstatic.com','zijieapi.com'];
const authHosts=new Set(['www.douyin.com','sso.douyin.com','creator.douyin.com','verify.zijieapi.com','verify.snssdk.com']);
export function allowsDouyinReadRequest(details,fixture){
 let u;try{u=new URL(details.url);}catch{return false;}
 if(u.username||u.password)return false;
 if(fixture){return details.method==='GET'&&u.origin===fixture.origin&&(u.pathname==='/bridge-fixture/'+fixture.nonce||u.pathname==='/bridge-fixture/'+fixture.nonce+'/self'||u.pathname==='/bridge-fixture/'+fixture.nonce+'/works');}
 if(u.protocol==='about:')return u.href==='about:blank';
 if(u.protocol!=='https:'||u.port)return false;
 const method=details.method.toUpperCase(),host=u.hostname,path=u.pathname;
 // Only the user's normal login/verification traffic may use POST. No data
 // mutation, publication, reply, upload or arbitrary third-party endpoint.
 if(authHosts.has(host)&&(/^\/passport\//.test(path)||/^\/captcha\//.test(path)))return ['GET','POST','OPTIONS'].includes(method);
 if(method!=='GET')return false;
 if(details.resourceType==='mainFrame'||details.resourceType==='subFrame')return host==='www.douyin.com'&&(/^\/$/.test(path)||/^\/user\/(?:self|[A-Za-z0-9_.-]+)\/?$/.test(path));
 if(details.resourceType==='xhr'||details.resourceType==='fetch')return host==='www.douyin.com'&&['/aweme/v1/web/user/profile/self/','/aweme/v1/web/aweme/post/'].includes(path);
 if(!['script','stylesheet','image','font','media','other'].includes(details.resourceType)||!staticHosts.some(s=>host===s||host.endsWith('.'+s)))return false;
 if(host==='douyin.com'||host.endsWith('.douyin.com'))return /^\/static\//.test(path)||/\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|mp4|webm)$/.test(path);
 return true;
}
