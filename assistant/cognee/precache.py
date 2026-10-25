"""Build-only downloads. Runtime runs with external networking disabled."""
import tiktoken
for name in ('cl100k_base', 'o200k_base'):
    encoding = tiktoken.get_encoding(name)
    assert encoding.decode(encoding.encode('synthetic assistant index')) == 'synthetic assistant index'
