import os
import torch
from transformers import GPT2LMHeadModel, GPT2Tokenizer
import argparse
import sys

class ModelInference:
    def __init__(self, model_dir='./trained_model', model_name='model'):
        self.model_dir = model_dir
        self.model_name = model_name
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = None
        self.tokenizer = None

        print(f"Using device: {self.device}")
        self.load_model()

    def load_model(self):
        """Load the trained model and tokenizer"""
        try:
            model_path = os.path.join(self.model_dir, self.model_name)

            if not os.path.exists(model_path):
                raise FileNotFoundError(f"Model directory not found: {model_path}")

            print("Loading trained model...")
            self.model = GPT2LMHeadModel.from_pretrained(model_path).to(self.device)
            self.tokenizer = GPT2Tokenizer.from_pretrained(model_path)

            # Set pad token if not already set
            if self.tokenizer.pad_token is None:
                self.tokenizer.pad_token = self.tokenizer.eos_token

            print(f"Model loaded successfully from {model_path}")
            print(f"Model has {sum(p.numel() for p in self.model.parameters())} parameters")

        except Exception as e:
            print(f"Error loading model: {e}")
            print("Make sure you have trained the model first using the training script.")
            sys.exit(1)

    def generate_response(self, prompt, max_length=200, temperature=0.7, top_p=0.9,
                         num_return_sequences=1, do_sample=True):
        """Generate response for a given prompt"""
        if self.model is None or self.tokenizer is None:
            print("Model not loaded properly!")
            return None

        # Set model to evaluation mode
        self.model.eval()

        # Format the input
        input_text = f"Prompt: {prompt}\nResponse:"

        # Tokenize input
        inputs = self.tokenizer(
            input_text,
            return_tensors='pt',
            truncation=True,
            padding=True,
            max_length=512
        ).to(self.device)

        # Generate response
        with torch.no_grad():
            outputs = self.model.generate(
                input_ids=inputs['input_ids'],
                attention_mask=inputs['attention_mask'],
                max_length=len(inputs['input_ids'][0]) + max_length,
                num_return_sequences=num_return_sequences,
                temperature=temperature,
                top_p=top_p,
                do_sample=do_sample,
                pad_token_id=self.tokenizer.eos_token_id,
                eos_token_id=self.tokenizer.eos_token_id
            )

        # Decode the generated text
        generated_texts = []
        for output in outputs:
            generated = self.tokenizer.decode(output, skip_special_tokens=True)
            # Extract only the response part
            if "Response:" in generated:
                response = generated.split("Response:")[1].strip()
            else:
                response = generated
            generated_texts.append(response)

        return generated_texts[0] if len(generated_texts) == 1 else generated_texts

    def interactive_mode(self):
        """Run in interactive mode for continuous prompting"""
        print("\n" + "="*50)
        print("Interactive Mode - GPT-2 Code Generator")
        print("="*50)
        print("Enter prompts to get code responses.")
        print("Type 'quit', 'exit', or 'q' to stop.")
        print("Type 'help' for available commands.")
        print("-"*50)

        while True:
            try:
                user_input = input("\nPrompt: ").strip()

                if user_input.lower() in ['quit', 'exit', 'q']:
                    print("Goodbye!")
                    break
                elif user_input.lower() == 'help':
                    self.show_help()
                    continue
                elif user_input.lower() == 'examples':
                    self.show_examples()
                    continue
                elif not user_input:
                    print("Please enter a prompt or 'quit' to exit.")
                    continue

                print("\nGenerating response...")
                response = self.generate_response(user_input)
                print(f"\nResponse:\n{response}")
                print("-"*50)

            except KeyboardInterrupt:
                print("\n\nExiting...")
                break
            except Exception as e:
                print(f"Error generating response: {e}")

    def show_help(self):
        """Show available commands"""
        print("\nAvailable commands:")
        print("- quit, exit, q: Exit the program")
        print("- help: Show this help message")
        print("- examples: Show example prompts")
        print("- Any other text: Use as prompt for code generation")

    def show_examples(self):
        """Show example prompts"""
        examples = [
            "Write a Python function to reverse a string",
            "Create a function to calculate factorial",
            "Implement a binary search algorithm",
            "Write a function to check if a number is prime",
            "Create a class for a simple calculator",
            "Implement a function to merge two sorted lists"
        ]

        print("\nExample prompts:")
        for i, example in enumerate(examples, 1):
            print(f"{i}. {example}")

def main(model_dir='./trained_model', model_name='model', prompt=None,
         max_length=200, temperature=0.7, top_p=0.9, interactive=None):
    """
    Main function that can be called directly or from command line
    """
    # Check if running in notebook environment
    try:
        get_ipython()
        in_notebook = True
    except NameError:
        in_notebook = False

    if in_notebook:
        # Running in notebook - use default interactive mode
        print("Detected notebook environment. Starting in interactive mode...")
        inference = ModelInference(model_dir, model_name)
        inference.interactive_mode()
    else:
        # Running from command line
        parser = argparse.ArgumentParser(description='GPT-2 Code Generator Inference Script')
        parser.add_argument('--model_dir', default='./trained_model',
                           help='Directory containing the trained model (default: ./trained_model)')
        parser.add_argument('--model_name', default='model',
                           help='Name of the model subdirectory (default: model)')
        parser.add_argument('--prompt', type=str,
                           help='Single prompt to generate response for')
        parser.add_argument('--max_length', type=int, default=200,
                           help='Maximum length of generated response (default: 200)')
        parser.add_argument('--temperature', type=float, default=0.7,
                           help='Temperature for generation (default: 0.7)')
        parser.add_argument('--top_p', type=float, default=0.9,
                           help='Top-p value for nucleus sampling (default: 0.9)')
        parser.add_argument('--interactive', action='store_true',
                           help='Run in interactive mode')

        args = parser.parse_args()

        # Initialize the inference class
        inference = ModelInference(args.model_dir, args.model_name)

        if args.prompt:
            # Single prompt mode
            print(f"Prompt: {args.prompt}")
            print("Generating response...")
            response = inference.generate_response(
                args.prompt,
                max_length=args.max_length,
                temperature=args.temperature,
                top_p=args.top_p
            )
            print(f"\nGenerated Response:\n{response}")
        elif args.interactive:
            # Interactive mode
            inference.interactive_mode()
        else:
            # Default to interactive mode
            print("No specific prompt provided. Starting interactive mode...")
            inference.interactive_mode()

def quick_generate(prompt, model_dir='./trained_model', model_name='model',
                  max_length=40000, temperature=0.7, top_p=0.9):
    """
    Quick function to generate a single response - perfect for notebook use
    """
    inference = ModelInference(model_dir, model_name)
    return inference.generate_response(prompt, max_length, temperature, top_p)

def start_interactive(model_dir='./trained_model', model_name='model'):
    """
    Start interactive mode - perfect for notebook use
    """
    inference = ModelInference(model_dir, model_name)
    inference.interactive_mode()

if __name__ == '__main__':
    main()
