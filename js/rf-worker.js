'use strict';
// Load the model with this worker's own ?v= so both come from the same build.
importScripts('rf-model.js' + self.location.search);
self.onmessage = ({data}) => {
  try { self.postMessage({id:data.id, margins:RFModel.coverageRay(data.profile,data.a,data.b,data.margin)}); }
  catch(error) { self.postMessage({id:data.id,error:error.message}); }
};
