// Opening ImageCrate does not request persistent access to image hosts.
// The workspace uses existing access and leaves any extra grant to an
// explicit preview or save action after the user can see the image sources.
export function createPreviewStartup({onOpen,onError=()=>{}}={}){
  const opening=new Map();
  return {
    open(tab){
      if(opening.has(tab.id))return opening.get(tab.id);
      let result;
      try{result=onOpen(tab);}catch(error){result=Promise.reject(error);}
      const pending=Promise.resolve(result).catch(onError).finally(()=>{
        if(opening.get(tab.id)===pending)opening.delete(tab.id);
      });
      opening.set(tab.id,pending);
      return pending;
    },
  };
}
