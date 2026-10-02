{
  description = "Taut, a client mod for Slack";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # the release workflow rewrites this block after each desktop release
      # begin releases (written by scripts/flake.ts)
      releases = {
        x86_64-linux = {
          version = "3.1.0";
          file = "taut-linux.AppImage";
          hash = "sha256-0I66Olq74uBgQsBneG73vlL4IENI+7s14BvEEqbRIaQ=";
        };
        aarch64-linux = {
          version = "3.1.0";
          file = "taut-linux-arm.AppImage";
          hash = "sha256-8sIkaKA8M0fjPbP/PEcnmz6wjKnBDoobjt4FBXHPiAE=";
        };
        x86_64-darwin = {
          version = "3.1.0";
          file = "taut-mac-x64.dmg";
          hash = "sha256-R6MgnugP8BWM5rz2BjV1veW4qSCaJ4paAzW8w+BbisM=";
        };
        aarch64-darwin = {
          version = "3.1.0";
          file = "taut-mac.dmg";
          hash = "sha256-0VXTkr5bVgqEFhN9pLAi4eJHAM0T4RFXOOm19dKcpJ8=";
        };
      };
      # end releases

      package =
        {
          lib,
          stdenv,
          stdenvNoCC,
          appimageTools,
          fetchurl,
          makeWrapper,
          _7zz,
        }:

        let
          system = stdenv.hostPlatform.system;
          release = releases.${system} or (throw "flake.nix has no ${system} release yet");
          pname = "taut";
          inherit (release) version;
          src = fetchurl {
            url = "https://github.com/jeremy46231/taut/releases/download/desktop-v${version}/${release.file}";
            inherit (release) hash;
          };
          meta = {
            description = "Client mod for Slack";
            homepage = "https://taut.jer.app";
            license = lib.licenses.gpl3Plus;
            platforms = builtins.attrNames releases;
            mainProgram = "taut";
            sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
          };
        in

        if stdenv.hostPlatform.isDarwin then
          # the signed and notarized app from the dmg
          stdenvNoCC.mkDerivation {
            inherit
              pname
              version
              src
              meta
              ;
            nativeBuildInputs = [
              _7zz
              makeWrapper
            ];
            sourceRoot = ".";
            # the volume is named after the version and arch, and the store
            # can't hold the extended attributes (-sns-)
            unpackPhase = ''
              7zz x -sns- -snld "$src" >/dev/null
              mv ./*/Taut.app Taut.app
            '';
            # fixup would strip and rewrite the signed binaries
            dontFixup = true;
            installPhase = ''
              mkdir -p $out/Applications $out/bin
              cp -R Taut.app $out/Applications/
              makeWrapper $out/Applications/Taut.app/Contents/MacOS/Taut $out/bin/taut
            '';
          }
        else
          let
            contents = appimageTools.extract { inherit pname version src; };
          in
          appimageTools.wrapType2 {
            inherit
              pname
              version
              src
              meta
              ;

            extraInstallCommands = ''
              install -Dm444 ${contents}/taut.desktop $out/share/applications/taut.desktop
              substituteInPlace $out/share/applications/taut.desktop \
                --replace-fail 'Exec=AppRun' 'Exec=taut'
              cp -r ${contents}/usr/share/icons $out/share/icons
            '';
          };

      forSystem = system: rec {
        taut = nixpkgs.legacyPackages.${system}.callPackage package { };
        default = taut;
      };
    in
    {
      packages = nixpkgs.lib.genAttrs (nixpkgs.lib.remove "x86_64-darwin" (builtins.attrNames releases)) forSystem;

      overlays.default = final: prev: { taut = final.callPackage package { }; };
    };
}
