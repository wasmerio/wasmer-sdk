import { collect, countLive } from './collection.js';

const memories = [];
const buffers = [];
onmessage = ({ data }) => {
  if (data.type === 'collect' || data.type === 'stats') {
    if (data.type === 'collect') collect();
    postMessage({ ...countLive(memories), buffers: countLive(buffers) });
  } else {
    memories.push(new WeakRef(data.memory));
    const buffer = data.memory.buffer;
    buffers.push(new WeakRef(buffer));
    new Uint8Array(buffer)[0] = 1;
    postMessage(data.id);
  }
};
