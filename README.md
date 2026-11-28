# fidget-toys

Experiments in smol browser strategy gaming. JavaScript games, one per directory, no fancy build pipeline.

- [Dot Army](dot-army/) — two swarms of dots fight over spawn points. You vs the CPU, or another person online.
- [Wooden Ships](wooden-ships/) — a two-ship sailing duel. You steer, the wind sets your speed. You vs the CPU, or another person online.
- [Coreward Bound](coreward-bound/) — jump fleets across a spiral galaxy and race the CPU to bring three relics home from the core. Turn-based.
- [Star Troopers](star-troopers/) — turn-based squad tactics, after SPI's *StarSoldier* (1977). Plot every trooper's orders in secret, then watch them play out. You vs the CPU. Still being balanced: it's here to be playtested.

To play, serve the repo with `python3 -m http.server 8000` and open <http://localhost:8000/>. Run every toy's tests with `npm test`, after one `npm install` (the network relay's only dependency, `ws`).

It's MIT licensed, yo. See [LICENSE](LICENSE).
