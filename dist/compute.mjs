import { createGPU, preparePrivateCDF, simulateCPU } from "./simulation.mjs";

function withDeadline(pending, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out")), milliseconds);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

export function createCompute(override) {
  const cpuOnly = override === "cpu";
  const gpuSession = new AbortController();
  let gpuReady;
  let workersAvailable = true;

  function disableGPU(error) {
    gpuSession.abort();
    console.warn("WebGPU unavailable. Using the CPU.", error);
    return null;
  }

  async function workerCompute(operation, parameters) {
    if (workersAvailable) {
      let worker;
      try {
        worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
        const result = new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data?.output) resolve(data.output);
            else reject(new Error(data?.error || "Worker returned no result"));
          };
          worker.onerror = (event) => reject(new Error(event.message || "Worker failed to start"));
          worker.onmessageerror = () => reject(new Error("Unable to read the worker result"));
          worker.postMessage({ operation, parameters });
        });
        return await withDeadline(result, 4000, "CPU worker");
      } catch (error) {
        workersAvailable = false;
        console.warn("Worker unavailable. Using the main thread.", error);
      } finally {
        worker?.terminate();
      }
    }
    return operation === "fit" ? preparePrivateCDF(parameters) : simulateCPU(parameters);
  }

  return async (parameters, setBackend) => {
    const gpu = cpuOnly || gpuSession.signal.aborted ? null : await (gpuReady ??= withDeadline(
      createGPU(gpuSession.signal), 2000, "WebGPU setup",
    ).catch(disableGPU));
    if (!gpu) setBackend("cpu");

    const prepared = parameters.mechanism === "cells" ? parameters : {
      ...parameters,
      fitted: await workerCompute("fit", parameters),
    };

    if (gpu) {
      try {
        const output = await withDeadline(gpu(prepared), 4500, "WebGPU simulation");
        setBackend("gpu", Boolean(prepared.fitted));
        return output;
      } catch (error) {
        disableGPU(error);
        setBackend("cpu");
      }
    }
    return workerCompute("simulate", prepared);
  };
}
