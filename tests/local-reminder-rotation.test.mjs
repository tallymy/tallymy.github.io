import test from 'node:test';import assert from 'node:assert/strict';import{readFile,mkdtemp,writeFile,rm}from'node:fs/promises';import{existsSync}from'node:fs';import{fileURLToPath}from'node:url';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{execFileSync}from'node:child_process';
const webRoot=process.env.TALLY_WEB_ROOT?resolve(process.env.TALLY_WEB_ROOT):fileURLToPath(new URL('../',import.meta.url));
const androidRoot=process.env.TALLY_ANDROID_ROOT?resolve(process.env.TALLY_ANDROID_ROOT):resolve(webRoot,'android-wrapper');
const javaRoot=process.env.TALLY_REMINDER_JAVA_ROOT?resolve(process.env.TALLY_REMINDER_JAVA_ROOT):resolve(androidRoot,'android/app/src/main/java/io/github/tallymy');
const langs=['en','ms','zh','zh-Hant','ja','ta'],read=p=>readFile(join(javaRoot,p),'utf8');
const home=process.env.JAVA_HOME||(process.platform==='win32'&&existsSync('D:/tools/jdk21-extract/jdk-21.0.12.1+1')?'D:/tools/jdk21-extract/jdk-21.0.12.1+1':null);
const tool=n=>home?join(home,'bin',n+(process.platform==='win32'?'.exe':'')):n;
const scheduler=await read('TallyReminderScheduler.java');
function method(signature){const start=scheduler.indexOf(signature);assert.ok(start>=0);let depth=0,end=scheduler.indexOf('{',start);for(;end<scheduler.length;end++){if(scheduler[end]==='{')depth++;if(scheduler[end]==='}'&&--depth===0)break;}return scheduler.slice(start,end+1);}
async function compile(harness){const dir=await mkdtemp(join(tmpdir(),'tally-reminder-rotation-'));try{for(const file of ['TallyReminderMessages.java','TallyReminderClock.java'])await writeFile(join(dir,file),await read(file));await writeFile(join(dir,'RotationTest.java'),harness);execFileSync(tool('javac'),['-encoding','UTF-8','-d',dir,...['TallyReminderMessages.java','TallyReminderClock.java','RotationTest.java'].map(p=>join(dir,p))],{timeout:20000});return execFileSync(tool('java'),['-Dfile.encoding=UTF-8','-cp',dir,'io.github.tallymy.RotationTest'],{timeout:20000,maxBuffer:16*1024*1024}).toString();}finally{await rm(dir,{recursive:true,force:true});}}
test('compiled production tables emit every Cartesian pair exactly once, with fallback and full-cycle boundaries',async()=>{
 const output=await compile(`package io.github.tallymy;import java.util.*;
 public class RotationTest{static void ok(boolean v){if(!v)throw new AssertionError();}public static void main(String[]args)throws Exception{System.setOut(new java.io.PrintStream(System.out,true,java.nio.charset.StandardCharsets.UTF_8));
 ok(TallyReminderMessages.COUNT==1000);ok(TallyReminderMessages.next(999)==0);ok(TallyReminderMessages.normalize(-1)==999);ok(TallyReminderMessages.next(Integer.MAX_VALUE)>=0);
 for(String lang:new String[]{"en","ms","zh","zh-Hant","ja","ta"}){Set<String>all=new HashSet<>();for(int i=0;i<1000;i++){String body=TallyReminderMessages.body(lang,i);ok(all.add(body));ok(body.equals(TallyReminderMessages.body(lang,i)));System.out.println(lang+"\\t"+i+"\\t"+body);}ok(all.size()==1000);String prefix=lang.equals("zh-Hant")?"ZH_HANT":lang.toUpperCase(java.util.Locale.ROOT);java.lang.reflect.Field of=TallyReminderMessages.class.getDeclaredField(prefix+"_OPEN"),inf=TallyReminderMessages.class.getDeclaredField(prefix+"_INVITE");of.setAccessible(true);inf.setAccessible(true);String[] openings=(String[])of.get(null),invitations=(String[])inf.get(null);ok(openings.length==40&&invitations.length==25);Set<String>expected=new HashSet<>();for(String opening:openings)for(String invitation:invitations){String text=opening+" "+invitation;ok(text.equals(text.trim()));ok(!text.contains("{")&&!text.contains("\\n"));expected.add(text);}ok(expected.equals(all));ok(TallyReminderMessages.body(lang,1000).equals(TallyReminderMessages.body(lang,0)));}
 for(int i=0;i<1000;i++){ok(TallyReminderMessages.body(null,i).equals(TallyReminderMessages.body("en",i)));ok(TallyReminderMessages.body("unknown",i).equals(TallyReminderMessages.body("en",i)));}
 // A calendar year, leap day, month/year boundaries and timezone/DST changes never reset a delivery cursor.
 Set<String>year=new HashSet<>();int cursor=0;for(int day=0;day<366;day++){ok(year.add(TallyReminderMessages.body("en",cursor)));cursor=TallyReminderMessages.next(cursor);}ok(year.size()==366);
 }}
 `);
 const rows=output.trim().split(/\r?\n/);assert.equal(rows.length,6000);
 for(const lang of langs){const actual=rows.filter(row=>row.startsWith(lang+'\t')).map(row=>row.split('\t').slice(2).join('\t'));assert.equal(actual.length,1000);assert.equal(new Set(actual).size,1000);for(let i=1;i<actual.length;i++)assert.notEqual(actual[i],actual[i-1]);}

});
test('actual scheduler fire advances cursor atomically only on eligible notification attempt and disable preserves it',async()=>{
 const production=[method('static String language('),method('static String body('),method('static void disable('),method('static void fire(')].join('\n');
 const result=await compile(`package io.github.tallymy;import java.util.*;
 public class RotationTest{
 static final Object LOCK=new Object();static final int ID=1;static final String CHANNEL="test";static boolean permission=true,commitWorks=true,notifyThrows;static int emitted;
 static class SharedPreferences{Map<String,Object>data=new HashMap<>();boolean getBoolean(String k,boolean d){return (boolean)data.getOrDefault(k,d);}String getString(String k,String d){return(String)data.getOrDefault(k,d);}int getInt(String k,int d){return(int)data.getOrDefault(k,d);}Editor edit(){return new Editor();}class Editor{Map<String,Object>next=new HashMap<>(data);Editor putBoolean(String k,boolean v){next.put(k,v);return this;}Editor putString(String k,String v){next.put(k,v);return this;}Editor putInt(String k,int v){next.put(k,v);return this;}Editor remove(String k){next.remove(k);return this;}boolean commit(){if(!commitWorks)return false;data=next;return true;}}}
 static SharedPreferences store=new SharedPreferences();static SharedPreferences prefs(Context c){return store;}static boolean allowed(Context c){return permission;}static void cancel(Context c){}
 static class Context{<T>T getSystemService(Class<T>type){return type.cast(type==NotificationManager.class?new NotificationManager():new AlarmManager());}}
 static class NotificationManager{static final int IMPORTANCE_DEFAULT=3;void createNotificationChannel(NotificationChannel c){}void notify(int id,Object notification){emitted++;if(notifyThrows)throw new IllegalStateException("delivery unknown");}}
 static class NotificationChannel{NotificationChannel(String a,String b,int c){}}
 static class NotificationCompat{static final int VISIBILITY_PRIVATE=0;static class BigTextStyle{String text;BigTextStyle bigText(String s){text=s;return this;}}static class Builder{Builder(Context c,String ch){}Builder setSmallIcon(int n){return this;}Builder setContentTitle(String s){return this;}String content;Builder setContentText(String s){content=s;return this;}Builder setStyle(BigTextStyle style){if(!content.equals(style.text))throw new AssertionError("Expanded text differs");return this;}Builder setContentIntent(PendingIntent p){return this;}Builder setAutoCancel(boolean b){return this;}Builder setVisibility(int n){return this;}Builder setOnlyAlertOnce(boolean b){return this;}Object build(){return this;}}}
 static class NotificationManagerCompat{static NotificationManagerCompat from(Context c){return new NotificationManagerCompat();}void cancel(int id){}}
 static class MainActivity{}static class Intent{static final int FLAG_ACTIVITY_CLEAR_TOP=1,FLAG_ACTIVITY_SINGLE_TOP=2;Intent(Context c,Class<?>k){}Intent addFlags(int n){return this;}}
 static class PendingIntent{static final int FLAG_UPDATE_CURRENT=1,FLAG_IMMUTABLE=2;static PendingIntent getActivity(Context c,int n,Intent i,int flags){return new PendingIntent();}}
 static class AlarmManager{static final int RTC_WAKEUP=1;void setAndAllowWhileIdle(int type,long at,PendingIntent p){}}
 static PendingIntent alarm(Context c,String day){return new PendingIntent();}static class Build{static class VERSION{static final int SDK_INT=36;}}static class R{static class drawable{static final int ic_reminder=1;}}
 ${production}
 static void ok(boolean v){if(!v)throw new AssertionError();}public static void main(String[]args){Context c=new Context();String day=TallyReminderClock.day(System.currentTimeMillis(),TimeZone.getDefault());
 store.edit().putBoolean("enabled",true).putBoolean("eligible",true).putString("knownDay",day).putInt("minute",0).commit();
 fire(c,day);ok(emitted==1&&store.getInt("messageCursor",0)==1);fire(c,day);ok(emitted==1&&store.getInt("messageCursor",0)==1);
 Map<String,Object>saved=new HashMap<>(store.data);store=new SharedPreferences();store.data=saved;disable(c);ok(store.getInt("messageCursor",0)==1);ok(!store.data.containsKey("knownDay"));fire(c,day);ok(emitted==1);
 store.edit().putBoolean("enabled",true).putBoolean("eligible",true).putString("knownDay",day).remove("notifiedDay").commit();permission=false;fire(c,day);ok(store.getInt("messageCursor",0)==1&&emitted==1);permission=true;
 store.edit().putString("expenseDay",day).commit();fire(c,day);ok(store.getInt("messageCursor",0)==1);store.edit().remove("expenseDay").commit();
 commitWorks=false;fire(c,day);ok(store.getInt("messageCursor",0)==1&&emitted==1);commitWorks=true;
 notifyThrows=true;try{fire(c,day);throw new AssertionError();}catch(IllegalStateException expected){}ok(store.getInt("messageCursor",0)==2);ok(day.equals(store.getString("notifiedDay","")));
 System.out.println("actual cursor policy passed");}}
 `);assert.match(result,/passed/);
});
