const accessBuffer = new URL(location.href).searchParams.get('receiverAccess') !== 'ignore';
onmessage = ({ data }) => {
  if (accessBuffer && data.memory) new Uint8Array(data.memory.buffer)[0] = 1;
  postMessage(data.id);
};
