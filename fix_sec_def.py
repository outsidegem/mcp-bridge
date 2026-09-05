import re

with open('src/db/triggers.sql', 'r') as f:
    sql = f.read()

# Add SET search_path = public
sql = sql.replace("$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;", "$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;")
sql = sql.replace("$$ LANGUAGE plpgsql SECURITY DEFINER;", "$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;")

# Qualify tables
sql = sql.replace("FROM _internal_secrets", "FROM public._internal_secrets")
sql = sql.replace("INSERT INTO requests ", "INSERT INTO public.requests ")
sql = sql.replace("UPDATE requests", "UPDATE public.requests")
sql = sql.replace("FROM requests", "FROM public.requests")
sql = sql.replace("ON requests", "ON public.requests")

sql = sql.replace("UPDATE quotas", "UPDATE public.quotas")
sql = sql.replace("UPDATE global_quota", "UPDATE public.global_quota")
sql = sql.replace("ON quotas", "ON public.quotas")
sql = sql.replace("ON global_quota", "ON public.global_quota")

sql = sql.replace("INSERT INTO audit_log ", "INSERT INTO public.audit_log ")
sql = sql.replace("FROM audit_log ", "FROM public.audit_log ")
sql = sql.replace("ON audit_log", "ON public.audit_log")

# In audit_request_changes, fix current_user
sql = sql.replace("current_user, prev_hash_val, curr_hash_val", "session_user, prev_hash_val, curr_hash_val")

with open('src/db/triggers.sql', 'w') as f:
    f.write(sql)
