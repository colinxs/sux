{
  # Reproducible dev shell for kagi-mcp / sux — `nix develop` gives the exact
  # node+npm toolchain, CI-parity, no "works on my machine". Nix-inspired: pin the
  # inputs, hash-address the result. (wrangler/vitest/tsc come from `npm ci`.)
  description = "sux — edge function engine (reproducible dev shell)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "sux dev shell · node $(node -v) · npm $(npm -v)"
            echo "  npm ci   →   npm run type-check   →   npm test   →   npm run docs"
          '';
        };
      });
    };
}
