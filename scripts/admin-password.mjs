import {randomBytes,scryptSync} from 'node:crypto';
if(!process.stdin.isTTY){console.error('Run this interactively to choose an admin password.');process.exit(1);}
process.stdout.write('New admin password (at least 16 characters): ');
process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
let password='';
process.stdin.on('data',chunk=>{
 for(const c of chunk){
 if(c==='\u0003'){process.stdin.setRawMode(false);process.exit(1);}
 if(c==='\r'||c==='\n'){
  process.stdin.setRawMode(false);process.stdout.write('\n');
  if(password.length<16){console.error('Choose at least 16 characters.');process.exit(1);}
  const salt=randomBytes(16).toString('hex');
  console.log(`ADMIN_PASSWORD_HASH=${salt}:${scryptSync(password,salt,64).toString('hex')}`);
  console.log(`ADMIN_SESSION_SECRET=${randomBytes(32).toString('hex')}`);process.exit(0);
 }
 if(c==='\u007f'){password=password.slice(0,-1);continue;}
 if(c>=' '&&password.length<512)password+=c;
 }
});
