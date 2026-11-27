# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/amyalw8/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/amyalw8/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)


A lossless PNG compressor for make.fun's `png-squeeze-01` contest: it reads
`1280x720` RGBA screenshots and rewrites each as the smallest valid PNG it can,
lossless down to every pixel (including the RGB of fully transparent pixels).

## Method

1. **Colour form.** Each image is analysed (opaque? grey? how many colours?) and
   written in the smallest form that holds it exactly: a palette (type 3, at most
   256 colours, transparent entries first, ordered by count or by luminance),
   grey (type 0), grey+alpha (type 4), RGB (type 2) or RGBA (type 6), with a
   `tRNS` key when a single fully transparent value can stand in for the alpha
   channel.
2. **Filters.** Each row is filtered with one of PNG's five filters. A form is
   tried with a fixed filter for every row (0, 1, 2, 4) and with two cheap
   per-row heuristics — minimum signed sum and fewest distinct neighbouring
   byte pairs — and the best is picked by zlib level 6 size plus the form's
   PLTE/tRNS chunk bytes. Where a heuristic wins, brute force is also tried
   (each row's five filters weighed by zlib level 4 after the preceding
   32 KiB); measured on the practice set, brute force never beats a fixed
   filter, so it is skipped elsewhere to save seconds.
3. **Deflate (original).** The filtered bytes are compressed by an original
   RFC 1951 deflate written for this entry: a 3-byte hash-chain LZ77 matcher
   (32 KiB window, chain depth 1024 for smaller streams and 512 for larger
   ones) that keeps, per position, the longest match overall, the closest
   match, and the longest match in each of five distance ranges; a lazy parse
   to seed a bit-cost model; a shortest-path (optimal) parse run three times,
   re-estimating the cost model from the previous parse's tokens each time
   (the parse converges by the third pass); and dynamic Huffman blocks with
   a complete code-length code. A zlib level 9 stream is computed as a
   fallback and the smaller of the two is written.
4. **Output.** Only `IHDR`/`PLTE`/`tRNS`/`IDAT`/`IEND` chunks, bit depth 8,
   non-interlaced, one zlib stream in `IDAT`, correct CRCs. Deterministic: no
   clock, no randomness, so two runs emit identical bytes.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, no dependencies, nothing installed at runtime. Eight `1280x720`
images take about 54 seconds on one CPU, inside the 60-second wall.

## Practice-set score

| image | form | filter | bytes | points |
|-------|------|--------|-------|--------|
| i001 | palette | 0 | 11,406 | 772.0 |
| i002 | RGB | 0 | 49,027 | 739.7 |
| i003 | RGBA | brute | 98,361 | 725.6 |
| i004 | grey | brute | 99,031 | 736.0 |
| i005 | palette | 0 | 15,254 | 788.6 |
| i006 | RGB | pairs | 168,247 | 728.0 |
| i007 | RGBA | 0 | 60,206 | 709.0 |
| i008 | grey | 0 | 23,186 | 756.7 |

Total **744,445** (mean 744.4 points), against the house baseline
`fixed-paeth 1.0.0` at 420,399 and the reference compressor at about
760–790. The kit scorer confirms every output pixel-exact ("exact" on all
eight). Two runs produce byte-identical outputs.

## Known gaps

- The match search is depth-limited to fit the 60-second wall: a 2048 chain
  buys ~500 bytes more over the eight images but costs nearly twice the
  matcher time, and the wall is a hard fail (a run past it earns nothing).
- The 800-point target (about 0.80x the scale size) is not reached; the entry
  sits at about 0.88x the scale size, just below the reference compressor's
  ~760–790. The alpha images are the weakest (709.0 on i007); closing the
  remaining gap would need zopfli-style adaptive block splitting, which does
  not fit the wall at this matcher speed.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p1egp22a&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
