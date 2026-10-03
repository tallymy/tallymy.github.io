import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
// Defaults are relative to this file after installation in repository tests/.
const webRoot=process.env.TALLY_WEB_ROOT?resolve(process.env.TALLY_WEB_ROOT):fileURLToPath(new URL('../',import.meta.url));
const androidRoot=process.env.TALLY_ANDROID_ROOT?resolve(process.env.TALLY_ANDROID_ROOT):resolve(webRoot,'android-wrapper');
const javaRoot=resolve(androidRoot,'android/app/src/main/java/io/github/tallymy');
const read=p=>readFile(resolve(webRoot,p),'utf8').then(s=>s.replace(/\r\n/g,'\n'));
const readJava=name=>readFile(resolve(javaRoot,name),'utf8');
const source=await readJava('TallyReminderScheduler.java');
function method(signature){const start=source.indexOf(signature);assert.ok(start>=0);let depth=0,end=source.indexOf('{',start);for(;end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}'&&--depth===0)break;}return source.slice(start,end+1);}
test('actual Java persistence policy writes date activity only after opt-in, denial stays off, disable removes markers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tally-reminder-policy-'));
 await writeFile(join(dir,'TallyReminderClock.java'),await readJava('TallyReminderClock.java'));
 const production=[method('static String language('),method('static void disable('),method('static void mirror('),method('static void configure(')].join('\n');
 await writeFile(join(dir,'PolicyTest.java'),`package io.github.tallymy;
 import java.util.*;
 public class PolicyTest {
 static final Object LOCK=new Object();static final int ID=3107;static String liveDay="",liveLang="en";static boolean liveLogged,liveEligible,permission=true;
 static class Context {} static Context context=new Context();static int schedules,cancels;
 static class SharedPreferences {Map<String,Object> data=new HashMap<>();boolean getBoolean(String k,boolean d){return (boolean)data.getOrDefault(k,d);}String getString(String k,String d){return (String)data.getOrDefault(k,d);}int getInt(String k,int d){return (int)data.getOrDefault(k,d);}Editor edit(){return new Editor();}
 class Editor{Map<String,Object>next=new HashMap<>(data);Editor putBoolean(String k,boolean v){next.put(k,v);return this;}Editor putString(String k,String v){next.put(k,v);return this;}Editor putInt(String k,int v){next.put(k,v);return this;}Editor remove(String k){next.remove(k);return this;}boolean commit(){data=next;return true;}}}
 static SharedPreferences store=new SharedPreferences();static SharedPreferences prefs(Context c){return store;}static boolean allowed(Context c){return permission;}
 static void schedule(Context c){schedules++;}static void cancel(Context c){cancels++;}
 static class NotificationManagerCompat {static NotificationManagerCompat from(Context c){return new NotificationManagerCompat();}void cancel(int id){cancels++;}}
 ${production}
 static void ok(boolean value){if(!value)throw new AssertionError();}
 public static void main(String[] args){String day=TallyReminderClock.day(System.currentTimeMillis(),TimeZone.getDefault());
 mirror(context,day,true,true,"ta");ok(store.data.isEmpty());
 permission=false;configure(context,true,1260);ok(!store.getBoolean("enabled",false));ok(!store.data.containsKey("knownDay"));ok(cancels>0);
 permission=true;configure(context,true,1260);ok(store.getBoolean("enabled",false));ok(day.equals(store.getString("expenseDay","")));ok("ta".equals(store.getString("lang","")));
 mirror(context,day,false,true,"ms");ok(store.getString("expenseDay","x").isEmpty());
 store.edit().putString("notifiedDay",day).commit();disable(context);for(String key:new String[]{"knownDay","expenseDay","notifiedDay","eligible"})ok(!store.data.containsKey(key));
 mirror(context,day,false,false,"en");try{configure(context,true,1200);throw new AssertionError();}catch(IllegalStateException expected){}ok(!store.getBoolean("enabled",false));
 System.out.println("opt-in persistence passed");}}
 `);
 const home=process.env.JAVA_HOME,tool=n=>home?join(home,'bin',n+(process.platform==='win32'?'.exe':'')):n;
 execFileSync(tool('javac'),['-d',dir,join(dir,'TallyReminderClock.java'),join(dir,'PolicyTest.java')],{timeout:20000});
 assert.match(execFileSync(tool('java'),['-cp',dir,'io.github.tallymy.PolicyTest'],{timeout:10000}).toString(),/passed/);
});
