onmessage = ({ data }) => {
  if (data.memory) new Uint8Array(data.memory.buffer)[0] = 1;
  postMessage(data.id);
};
