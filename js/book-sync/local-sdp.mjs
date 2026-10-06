// Signaled LAN host candidates only. This is not a browser/network firewall:
// mDNS resolution and interface/VPN routing remain browser/OS responsibilities.
import {validSdp} from './desk-pair.js';
const fail=()=>{throw Object.assign(Error('No permitted local connection. Check the same network and try again.'),{code:'LOCAL_SDP'});};
const decimal=(s,max)=>/^(?:0|[1-9]\d*)$/.test(s)&&Number(s)<=max;
const ipv4=s=>typeof s==='string'&&s.split('.').length===4&&s.split('.').every(n=>decimal(n,255));
function ipv6(s){
  if(!/^[a-f0-9:]+$/i.test(s)||!s.includes(':'))return null;
  const sides=s.split('::');if(sides.length>2)return null;
  const parts=side=>side?side.split(':'):[],left=parts(sides[0]),right=parts(sides[1]||'');
  if([...left,...right].some(n=>!/^[a-f0-9]{1,4}$/i.test(n)))return null;
  if(sides.length===1)return left.length===8?left:null;
  return left.length+right.length<8?[...left,...Array(8-left.length-right.length).fill('0'),...right]:null;
}
export function localIceAddress(s){
  if(typeof s!=='string'||s.length>100)return false;
  if(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.local$/i.test(s))return true;
  if(s.includes('.')){
    const p=s.split('.');if(p.length!==4||p.some(n=>!decimal(n,255)))return false;
    const a=p.map(Number);return a[0]===10||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&a[1]===168||a[0]===169&&a[1]===254&&a[2]>=1&&a[2]<=254;
  }
  const words=ipv6(s);if(!words)return false;
  const first=parseInt(words[0],16);return (first&0xfe00)===0xfc00||(first&0xffc0)===0xfe80;
}
function candidate(line){
  const p=line.slice(12).split(' ');if(p.length<8||p.some(x=>!x)||!/^[-A-Za-z0-9+/]{1,32}$/.test(p[0])||p[1]!=='1'||!['udp','tcp'].includes(p[2].toLowerCase())||!decimal(p[3],2147483647)||Number(p[3])===0||!decimal(p[5],65535)||Number(p[5])===0||p[6]!=='typ'||!['host','srflx','prflx','relay'].includes(p[7])||(p.length-8)%2)fail();
  const ext=new Map();for(let i=8;i<p.length;i+=2){const k=p[i],v=p[i+1];if(ext.has(k)||!['generation','network-id','network-cost','ufrag','tcptype','raddr','rport'].includes(k))fail();ext.set(k,v);
    if(['generation','network-id','network-cost'].includes(k)&&!decimal(v,65535))fail();
    if(k==='ufrag'&&!/^[A-Za-z0-9+/_-]{4,256}$/.test(v))fail();
    if(k==='tcptype'&&!['active','passive','so'].includes(v))fail();
    if(k==='rport'&&(!decimal(v,65535)||Number(v)===0))fail();
  }
  const tcp=p[2].toLowerCase()==='tcp';if(tcp!==ext.has('tcptype')||tcp&&ext.get('tcptype')==='active'&&p[5]!=='9'||p[7]==='host'&&(ext.has('raddr')||ext.has('rport')))fail();
  return {address:p[4],port:p[5],safe:p[7]==='host'&&localIceAddress(p[4])};
}
function parse(sdp,owned){
  validSdp(sdp);if(!sdp.endsWith('\r\n')||/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(sdp))fail();
  const lines=sdp.slice(0,-2).split('\r\n');if(lines.length>512||lines.some(x=>!x||/[\r\n]/.test(x)))fail();
  const media=lines.filter(x=>x.startsWith('m='));if(media.length!==1||!/^m=application (?:0|[1-9]\d{0,4}) UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]))fail();
  const m=media[0].split(' '),port=m[1];if(!decimal(port,65535)||Number(port)===0)fail();
  const fingerprints=lines.filter(x=>x.startsWith('a=fingerprint:'));if(fingerprints.length!==1)fail();
  if(lines.some(x=>x.startsWith('a=remote-candidates:')||x.startsWith('a=rtcp:')||x.startsWith('a=rtcp-mux')))fail();
  const connection=lines.filter(x=>x.startsWith('c='));if(connection.length!==1)fail();
  const cp=connection[0].split(' ');if(cp.length!==3||cp[0]!=='c=IN'||!['IP4','IP6'].includes(cp[1])||cp[1]==='IP4'&&!ipv4(cp[2])||cp[1]==='IP6'&&!ipv6(cp[2]))fail();
  const all=lines.filter(x=>x.startsWith('a=candidate:'));if(all.length<1||all.length>128)fail();
  const candidates=all.map(candidate),kept=candidates.filter(c=>c.safe);if(!kept.length||!owned&&kept.length!==candidates.length)fail();
  const placeholder=port==='9'&&(cp[1]==='IP4'&&cp[2]==='0.0.0.0'||cp[1]==='IP6'&&cp[2]==='::');
  const defaultSafe=localIceAddress(cp[2])&&kept.some(c=>c.address===cp[2]&&c.port===port);
  if(!owned&&!placeholder&&!defaultSafe)fail();
  return lines.filter(x=>!x.startsWith('a=candidate:')||candidate(x).safe).map(x=>owned&&!placeholder&&!defaultSafe?(x===media[0]?'m=application 9 UDP/DTLS/SCTP webrtc-datachannel':x===connection[0]?'c=IN IP4 0.0.0.0':x):x).join('\r\n')+'\r\n';
}
export const sanitizeLocalSdp=sdp=>parse(sdp,true);
export const validateRemoteSdp=sdp=>parse(sdp,false);
