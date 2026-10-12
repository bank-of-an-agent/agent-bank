{
  description = "Agent Bank development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm_10 # matches packageManager in package.json
            postgresql_16
            foundry
            opentofu
            uv
            python3
            jq
            gh
          ];
          shellHook = ''
            echo "Agent Bank dev shell — testnet only (Base Sepolia). See docs/architecture.md."
          '';
        };
      });
}
