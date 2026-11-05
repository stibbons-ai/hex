{ pkgs, ... }:

{
  packages = [
    pkgs.git
    pkgs.bun
  ];

  env = {
    MASTRA_TELEMETRY_DISABLED = "1";
    DO_NOT_TRACK = "1";
  };

  tasks."hex:install" = {
    exec = "bun install --frozen-lockfile";
    before = [ "devenv:enterShell" ];
  };

  # Model keys for evals and live runs (secretspec.toml, README "Development shell and model keys"),
  # exported into the live shell only. Never via `env`: that would write them into the
  # world-readable Nix store.
  enterShell = ''
    if secretspec_exports="$(secretspec export --format shell --reason "devenv shell: hex model keys for evals and live runs")"; then
      eval "$secretspec_exports"
    else
      echo "secretspec: model keys not loaded; a model call will fail on the missing key" >&2
    fi
    unset secretspec_exports
  '';
}
