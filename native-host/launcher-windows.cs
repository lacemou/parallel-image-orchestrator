using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

internal static class Program
{
    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FindNode()
    {
        string configuredPath = ReadConfiguredNodePath();
        string[] candidates =
        {
            configuredPath,
            Environment.GetEnvironmentVariable("PIO_NODE_PATH"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            "node.exe"
        };

        return candidates.FirstOrDefault(path =>
            !String.IsNullOrEmpty(path) && (path.Equals("node.exe", StringComparison.OrdinalIgnoreCase) || File.Exists(path))) ?? "node.exe";
    }

    private static string ReadConfiguredNodePath()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string configPath = Path.Combine(localAppData, "Parallel Image Orchestrator", "NativeMessagingHosts", "node-path.txt");
        try
        {
            string configuredPath = File.ReadAllText(configPath).Trim();
            return String.IsNullOrEmpty(configuredPath) ? null : configuredPath;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string FindBridge()
    {
        return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "bridge", "native-host.js"));
    }

    public static int Main()
    {
        string bridgePath = FindBridge();
        if (!File.Exists(bridgePath))
        {
            Console.Error.WriteLine("parallel-image-orchestrator: bridge not found: " + bridgePath);
            return 2;
        }

        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = FindNode(),
            Arguments = QuoteArgument(bridgePath),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = false,
            WorkingDirectory = Path.GetDirectoryName(bridgePath)
        };

        Process child;
        try
        {
            child = Process.Start(startInfo);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("parallel-image-orchestrator: unable to start Node: " + error.Message);
            return 3;
        }

        Task copyInput = Task.Run(() =>
        {
            try
            {
                using (Stream input = Console.OpenStandardInput())
                {
                    byte[] buffer = new byte[1];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        child.StandardInput.BaseStream.Write(buffer, 0, read);
                        child.StandardInput.BaseStream.Flush();
                    }
                }
            }
            catch (IOException)
            {
                // Chrome can close the pipe while the child is exiting.
            }
            finally
            {
                try { child.StandardInput.Close(); } catch { }
            }
        });

        Task copyOutput = Task.Run(() =>
        {
            try
            {
                using (Stream output = Console.OpenStandardOutput())
                {
                    byte[] buffer = new byte[1];
                    int read;
                    while ((read = child.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                        output.Flush();
                    }
                }
            }
            catch (IOException)
            {
                // Chrome can close the pipe while the child is exiting.
            }
        });

        try
        {
            Task.WaitAll(copyInput, copyOutput);
            child.WaitForExit();
            return child.ExitCode;
        }
        finally
        {
            child.Dispose();
        }
    }
}
