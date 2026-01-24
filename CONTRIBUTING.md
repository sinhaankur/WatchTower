# Contributing to WatchTower

Thank you for considering contributing to WatchTower! This document provides guidelines for contributing to the project.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help create a welcoming environment for all contributors

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in Issues
2. If not, create a new issue with:
   - Clear description of the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (OS, Python version, Podman version)
   - Relevant logs

### Suggesting Enhancements

1. Check if the enhancement has been suggested
2. Create an issue describing:
   - The problem the enhancement solves
   - Proposed solution
   - Alternative solutions considered
   - Impact on existing functionality

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes following our coding standards
4. Add tests for new functionality
5. Ensure all tests pass: `pytest tests/`
6. Update documentation as needed
7. Commit with clear messages
8. Push to your fork
9. Open a pull request

## Development Setup

```bash
# Clone the repository
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower

# Install dependencies
pip3 install -r requirements.txt
pip3 install pytest pytest-cov

# Run tests
pytest tests/ -v

# Run with coverage
pytest --cov=watchtower tests/
```

## Coding Standards

### Python Style

- Follow PEP 8
- Use meaningful variable names
- Add docstrings to functions and classes
- Keep functions focused and small
- Use type hints where appropriate

### Documentation

- Update README.md for user-facing changes
- Add docstrings to new functions/classes
- Include inline comments for complex logic
- Update configuration examples if needed

### Testing

- Write unit tests for new functionality
- Ensure existing tests pass
- Aim for good code coverage
- Test edge cases

## Project Structure

```
watchtower/
├── watchtower/          # Main package
│   ├── __init__.py
│   ├── cli.py          # CLI interface
│   ├── config.py       # Configuration management
│   ├── logger.py       # Logging setup
│   ├── main.py         # Entry point
│   ├── podman_manager.py  # Podman operations
│   ├── scheduler.py    # Scheduling
│   └── updater.py      # Update logic
├── config/             # Configuration files
├── systemd/            # Service files
├── tests/              # Unit tests
└── docs/               # Documentation
```

## Commit Messages

Use clear, descriptive commit messages:

```
Add feature to automatically retry failed updates

- Implement exponential backoff for retries
- Add configuration option for max retries
- Update documentation with retry behavior
```

## Testing Checklist

Before submitting a PR:

- [ ] All tests pass locally
- [ ] New tests added for new functionality
- [ ] Documentation updated
- [ ] Code follows style guidelines
- [ ] No breaking changes (or clearly documented)
- [ ] Configuration examples updated if needed

## Questions?

Feel free to open an issue with questions or contact the maintainers.

Thank you for contributing to WatchTower!
