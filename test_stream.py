import requests
import json

def stream_response(url, data):
    """Streams the response from the server and yields each word."""
    with requests.post(url, headers={"Content-Type": "application/json"}, data=json.dumps(data), stream=True) as response:
        if response.encoding is None:
            response.encoding = 'utf-8'

        for line in response.iter_lines(decode_unicode=True):
            if line:  # Filter out keep-alive chunks
                #print(line)
                if 'data: {' in line:
                    #print(line)
                    data = json.loads(line.replace('data: ', ''))
                    if 'choices' in data:
                        try:
                            #print(data['choices'][0]['delta']['content'])
                            yield data['choices'][0]['delta']['content']
                        except KeyError:
                            pass
                        #print(data['choices'][0]['delta']['content'])
                        #for choice in data['choices']:
                        #    if 'text' in choice:
                        #        yield choice['text'].strip()  # Yield individual words

# Set up your data
url = 'http://192.168.86.247:1234/v1/chat/completions'
data = { 
    "model": "model-identifier",
    "messages": [ 
        { "role": "system", "content": "Always answer in rhymes." },
        { "role": "user", "content": "Introduce yourself." }
    ], 
    "temperature": 0.7, 
    "max_tokens": -1,
    "stream": True
}

# Process the streaming words
for word in stream_response(url, data):
    print(word)  # Do something with each word (print here for example) 
