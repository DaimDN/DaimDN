const parseTextWithJson = (inputText) => {
  if (!inputText || typeof inputText !== 'string') {
    return [{ type: 'text', content: inputText || '' }];
  }

  const regex = /\[&\^\s*(.*?)\s*\^&\]/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let hasMatches = false;

  while ((match = regex.exec(inputText)) !== null) {
    hasMatches = true;
    
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: inputText.slice(lastIndex, match.index)
      });
    }

    try {
      const jsonString = match[1].trim();
      const jsonData = JSON.parse(jsonString);
      parts.push({
        type: 'json',
        content: jsonData,
        raw: jsonString
      });
    } catch (error) {
      parts.push({
        type: 'text',
        content: match[0]
      });
    }

    lastIndex = regex.lastIndex;
  }

  if (!hasMatches) {
    return [{ type: 'text', content: inputText }];
  }

  if (lastIndex < inputText.length) {
    parts.push({
      type: 'text',
      content: inputText.slice(lastIndex)
    });
  }

  return parts;
};
