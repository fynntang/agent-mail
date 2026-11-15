import {expect,it} from 'vitest';
import {alertNotificationCsvCell,ALERT_NOTIFICATION_CSV_COLUMNS,ALERT_NOTIFICATION_EXPORT_MAX_BYTES,formatAlertNotificationExport} from '../../src/lib/server/core/alert-notification-export-format';
import type {AlertNotificationExport} from '../../src/lib/types/alert-notification-export';

function fixture():AlertNotificationExport{
  const at=Date.parse('2026-11-15T00:00:00.000Z'),delivery={total:1,pending:0,running:0,succeeded:1,dead:0,cancelled:0,attempts:1,quietDeferred:0};
  return {version:1,generatedAt:at,mailboxId:crypto.randomUUID(),window:{from:at-86_400_000,to:at},filters:{decision:'all',eventType:'all'},snapshot:{decisionWatermark:1},
    summary:{total:1,allowed:1,skipped:0,byDecision:{allowed:1,disabled:0,quiet_hours:0,repeat_limited:0,recovery_disabled:0,no_subscribers:0},delivery},
    decisions:[{eventId:crypto.randomUUID(),alertId:crypto.randomUUID(),decision:'allowed',policyVersion:0,decidedAt:at-1,eventAvailable:true,eventType:'created',kind:'sync',outcome:'failed',
      errorCode:'cloudflare_api_unavailable',occurredAt:at-2,delivery,deliveries:[{id:crypto.randomUUID(),mailboxId:'fixture',endpointId:crypto.randomUUID(),eventId:'fixture',eventType:'cloudflare.suppression.alert.created',
        state:'succeeded',attempts:1,attemptBudget:8,availableAt:at-1,lastHttpStatus:204,lastErrorCode:null,secretVersion:1,createdAt:at-1,updatedAt:at,completedAt:at}]}]};
}
/** Independent RFC4180 reader: commas and line endings inside quoted cells remain data. */
function readCsv(bytes:Uint8Array):string[][]{
  const text=new TextDecoder().decode(bytes),rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(cell);cell='';}
    else if(char==='\r'&&text[i+1]==='\n'&&!quoted){row.push(cell);rows.push(row);row=[];cell='';i++;}
    else cell+=char;
  }
  expect(quoted).toBe(false);expect(row).toEqual([]);expect(cell).toBe('');return rows;
}
it('exports a single valid CSV table with BOM, complete metadata, noise statistics and separate endpoint results',()=>{
  const data=fixture(),bytes=formatAlertNotificationExport(data,'csv');expect([...bytes.slice(0,3)]).toEqual([239,187,191]);
  const [header,...rows]=readCsv(bytes);expect(header).toEqual([...ALERT_NOTIFICATION_CSV_COLUMNS]);expect(rows.every(row=>row.length===header.length)).toBe(true);
  const records=rows.map(row=>Object.fromEntries(header.map((name,index)=>[name,row[index]])));
  expect(records.filter(row=>row.row_type==='metadata').find(row=>row.metric==='window.to_utc')?.value).toBe('2026-11-15T00:00:00.000Z');
  expect(records.filter(row=>row.row_type==='summary').find(row=>row.metric==='delivery.succeeded')?.value).toBe('1');
  const item=records.find(row=>row.row_type==='decision')!,delivery=records.find(row=>row.row_type==='delivery')!;
  expect(item.event_id).toBe(data.decisions[0].eventId);expect(item.delivery_succeeded).toBe('1');expect(item.event_available).toBe('true');
  expect(delivery.event_id).toBe(item.event_id);expect(delivery.last_http_status).toBe('204');expect(delivery.last_error_code).toBe('');
});
it('preserves Unicode and multiline fields while neutralizing spreadsheet formulas independently of CSV quoting',()=>{
  const data=fixture();data.decisions[0].alertId=' =HYPERLINK("https://example.invalid", "你好")\r\nnext';
  const [header,...rows]=readCsv(formatAlertNotificationExport(data,'csv')),record=rows.find(row=>row[0]==='decision')!;
  expect(record[header.indexOf('alert_id')]).toBe("'"+data.decisions[0].alertId);
  for(const value of ['=1+1','+1','-1','@SUM(1)',' \t=1','\r\ntext','\ttext','\u200b=1'])expect(alertNotificationCsvCell(value)).toMatch(/^"'/);
  expect(alertNotificationCsvCell('中文,"safe"\ntext')).toBe('"中文,""safe""\ntext"');
});
it('produces exact JSON and valid empty exports without inventing a decision or dropping zero statistics',()=>{
  const data=fixture();data.decisions=[];data.summary={...data.summary,total:0,allowed:0,skipped:0,byDecision:{allowed:0,disabled:0,quiet_hours:0,repeat_limited:0,recovery_disabled:0,no_subscribers:0},
    delivery:{total:0,pending:0,running:0,succeeded:0,dead:0,cancelled:0,attempts:0,quietDeferred:0}};
  const bytes=formatAlertNotificationExport(data,'json');expect(new TextDecoder().decode(bytes).startsWith('{')).toBe(true);expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(data);
  const [, ...rows]=readCsv(formatAlertNotificationExport(data,'csv'));expect(rows.length).toBeGreaterThan(10);expect(rows.every(row=>['metadata','summary'].includes(row[0]))).toBe(true);
});
it('rejects oversized serialized CSV or JSON before a file can be returned',()=>{
  const data=fixture();data.decisions[0].alertId='x'.repeat(ALERT_NOTIFICATION_EXPORT_MAX_BYTES);
  for(const format of ['csv','json'] as const)expect(()=>formatAlertNotificationExport(data,format)).toThrowError('alert_notification_export_too_large');
});
