// Tabbit CLI stdin helper copied exactly from the actually exercised native-dialog program.
// Requires task globals page, assert and pvs.dialogs. Reject unexpected dialog text.
// Install this helper before clicking. Cancellation must not wait for a navigation.
globalThis.confirmAction=async(locator,message,decision)=>{
  const stop=new AbortController();let record;
  const handled=page.waitForEvent('dialog',{timeout:10000,signal:stop.signal}).then(async d=>{
    const expected=d.type()==='confirm'&&d.message()===message;record={type:d.type(),message:d.message(),decision:expected?decision:'unexpected-dismiss',at:Date.now()};
    if(expected&&decision==='accept')await d.accept();else await d.dismiss();
    pvs.dialogs.push(record);assert(expected,'Unexpected dialog dismissed');
  });
  try{await Promise.all([handled,locator.click({timeout:10000})]);return record;}finally{stop.abort();}
};
