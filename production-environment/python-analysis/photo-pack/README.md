# Photo inventory (ovhe)

Live lists are built **on the VPS**, not on a laptop agent VM:

```bash
ssh ovhe
bash ~/sillage/python-analysis/photo-pack/run_on_vps.sh
# writes ~/photo-inventory/ (CSVs + COUNTS.json)
```

That does not change the shop. `scraped/` is unreviewed. Do not copy it onto the CDN
until a human has looked. Do not open extra firewall ports to serve zips — `scp` from
the VPS, or copy files that already live in `~/ecom_sites/data/media/`.
