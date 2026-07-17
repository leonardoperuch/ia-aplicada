import os
from dotenv import load_dotenv
from crewai import LLM
import crewai.llms.cache as crewai_cache

load_dotenv()

# Workaround: a partir do crewai 1.15, mensagens são marcadas com a flag
# interna 'cache_breakpoint' (prompt caching), mas ela só é removida no
# adaptador da Anthropic antes de seguir para o provedor. No caminho
# genérico usado pelo Groq (via litellm), a flag vaza para a API e o
# Groq rejeita a requisição. Como o Groq não usa cache breakpoints,
# desativamos a marcação.
crewai_cache.mark_cache_breakpoint = lambda message: message

# Centraliza a inteligência do projeto
nexus_llm = LLM(
    model="groq/llama-3.1-8b-instant",
    api_key=os.getenv("GROQ_API_KEY"),
    temperature=0.2
)