# open-ch

An open-source server backend written for the analysis extension chesshelper.ai allowing you to use the extension without an account and for free.

The extension itself doesn't really use any kind of protective measures just that the analysis for moves is done on the server which is of course not given to you, using some sort of engine (most likely stockfish) to find moves.

So, we can just do the same thing by writing our own local server which supports their API protocol and use stockfish to analyze and spit back moves.

# Installation

Download the .zip of this repository and unzipt it in your browser's Extensions directory, for me it is:
`.config/chromium/Default/Extensions`

create a directory, name it "open-ch" and a directory inside it named "1.0.5_0", inside the last directory unzip the repository you downloaded and reload chrome/chromium.

### Starting the server
You will need nodejs for this, make sure to install all the dependencies:

```
npm ci
```

inside your "1.0.5_0" directory you will find a "server" directory, cd into it with a terminal instance and run "node server.js", make sure to either use tmux or something or just dont close the terminal while you use the extension.

### Notes
Just as something off-topic, this is exactly the kind of stuff I do not like, people like this make money off of vibecoded software, the entire extension is very obviously made with AI (they even left the comments in) and the fact they try to sell this and probably did get some sales is just sad.
