import { preparePrivateCDF, simulateCPU } from "./simulation.mjs";

self.onmessage = ({ data: { operation, parameters } }) => {
  try {
    const output = operation === "fit" ? preparePrivateCDF(parameters) : simulateCPU(parameters);
    self.postMessage({ output }, [output.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
