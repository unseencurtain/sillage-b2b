#!/usr/bin/env bash
# Obsolete. This used to bolt a second WordPress onto the retail Sillage VPS.
# Wholesale is this repo: an empty Ubuntu box is
#   ssh root@HOST 'bash -s' < production-environment/scripts/bootstrap-host.sh
#   ./production-environment/scripts/deploy-vps.sh --host … --shop … --dash … --images …
echo "bootstrap-wholesale.sh is retired. Use bootstrap-host.sh + deploy-vps.sh for an empty VPS." >&2
exit 1
