# fidget-toys

Experiments in one-shot gaming. Small browser games, one per directory, with no build step.

- [Dot Army](dot-army/) — two swarms of dots fight over spawn points. You vs the CPU, or another person online.
- [Coreward Bound](coreward-bound/) — jump fleets across a spiral galaxy and race the CPU to bring three relics home from the core. Turn-based.

To play, serve the repo with `python3 -m http.server 8000` and open <http://localhost:8000/>. Run every toy's tests with `npm test`, after one `npm install` (the network relay's only dependency, `ws`).

It's MIT licensed, yo. See [LICENSE](LICENSE).
