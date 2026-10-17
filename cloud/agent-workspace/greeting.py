def greet(name):
    name = name.strip()
    if not name:
        raise ValueError("Name cannot be empty or whitespace-only")
    return f"Hello, {name}!"