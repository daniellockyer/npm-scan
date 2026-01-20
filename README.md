# npm-scan

Monitors newly published npm package versions and flags publishes that **introduce** a `preinstall` or `postinstall` script. These lifecycle scripts can pose security risks, as they execute automatically during package installation and may be introduced in updates without users noticing.

The tool uses npm's replicate database (`replicate.npmjs.com`) to track changes, then fetches full package metadata from the registry to compare scripts between versions.

## Hall of Fame

Malicious packages are screened and reported by myself. This project has led to the following results as of January 20th, 2026:

- **11 packages** have been reported
- **7 packages** has been removed

Including at least 1 instance of live malware:

<img width="363" height="150" alt="image" src="https://github.com/user-attachments/assets/f3d6822e-5aac-4600-a7ec-7a2c63112ea8" />

## Author

**Daniel Lockyer** <hi@daniellockyer.com>

[GitHub Sponsors](https://github.com/sponsors/daniellockyer)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
