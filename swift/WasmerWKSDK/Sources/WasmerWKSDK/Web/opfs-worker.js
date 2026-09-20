import { OPFSVolume, filesystemError } from './opfs-filesystem.js';
import { isHostFileSystemRequest, respondToHostFileSystem } from './sdk/dist/host-filesystem.js';
const volumes = new Map();
let queue = Promise.resolve();
onmessage = ({data}) => {
  queue = queue.then(async () => {
    if (isHostFileSystemRequest(data)) {
      try {
        const volume = volumes.get(data.mount);
        if (!volume) throw Object.assign(new Error('OPFS volume is closed'), {code:'EBADF'});
        respondToHostFileSystem(data, {value:await volume.request(data.method, data.args)});
      } catch (error) { respondToHostFileSystem(data, {error:filesystemError(error)}); }
      return;
    }
    try {
      if (data.method === 'open') volumes.set(data.mount, data.volume == null ? OPFSVolume.memory() : await OPFSVolume.open(data.volume));
      else if (data.method === 'close') { await volumes.get(data.mount)?.close(); volumes.delete(data.mount); }
      else throw new Error('Invalid OPFS worker message');
      postMessage({id:data.id, value:true});
    } catch (error) { postMessage({id:data.id, error:filesystemError(error)}); }
  }).catch(error => { throw error; });
};
