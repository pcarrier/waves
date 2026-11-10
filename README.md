# Privacy Waves

Paint a joint histogram, simulate differential privatization, and compare synthetic histograms with the painted distribution.

Serve the static app from this directory and open [localhost:8000](http://localhost:8000).

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

The browser tries WebGPU and falls back to CPU computation when it is unavailable or fails. Add `?compute=cpu` to skip WebGPU. The methods that fit a distribution do so in a CPU worker before resampling. Use **Random seed → Use last seed** to compare methods on the same input histogram while keeping the painting, resolution, and sample size fixed.

The Method panel describes the privacy model, post-processing, and metrics. The simulation exposes the original and its deltas for learning with synthetic inputs.
